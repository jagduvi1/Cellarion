/**
 * Security alerting — passive summary + spike-triggered email.
 *
 * The audit log captures every security-relevant event already; this module
 * lets admins see the count at a glance (SuperAdmin nav badge via
 * routes/admin/security.js) and pings them by email only when something
 * genuinely abnormal happens. Real-time per-event alerts were deliberately
 * skipped — noisy, attacker-driveable, and an admin can't take action on a
 * single 429 anyway.
 */

const AuditLog = require('../models/AuditLog');
const SiteConfig = require('../models/SiteConfig');
const { sendSecurityAlertEmail } = require('./mailgun');

// Audit-log action names that count as security events. Keep in sync with
// the limiter/lockout sites that emit them.
const SECURITY_EVENT_ACTIONS = [
  'system.rate_limit_exceeded',
  'auth.account_locked',
  'auth.login.failed',
];

// Spike thresholds — if any of these are met in the lookback window, fire one
// alert email (subject to cooldown). Tuned conservatively so legitimate
// activity (a busy household IP, a developer testing) never trips them.
const SPIKES = {
  lockoutsPerHour:           { count: 3,  action: 'auth.account_locked',         windowMs: 60 * 60 * 1000 },
  rateLimitHitsPerUserPerHr: { count: 50, action: 'system.rate_limit_exceeded',  windowMs: 60 * 60 * 1000 },
};

// Cooldown so a sustained spike doesn't email the admin every 15 minutes.
const COOLDOWN_MS = 4 * 60 * 60 * 1000;
const lastAlertAt = new Map(); // spike key -> ms timestamp

/**
 * Counts of security events over the last 24h, grouped by action.
 * Used by GET /api/admin/security/summary to drive the SuperAdmin nav badge.
 */
async function getSecuritySummary() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [total, byAction, latest] = await Promise.all([
    AuditLog.countDocuments({ action: { $in: SECURITY_EVENT_ACTIONS }, timestamp: { $gte: since } }),
    AuditLog.aggregate([
      { $match: { action: { $in: SECURITY_EVENT_ACTIONS }, timestamp: { $gte: since } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]),
    AuditLog.find({ action: { $in: SECURITY_EVENT_ACTIONS }, timestamp: { $gte: since } })
      .sort({ timestamp: -1 })
      .limit(5)
      .select('action timestamp actor detail')
      .populate('actor.userId', 'username email')
      .lean(),
  ]);
  const counts = {};
  for (const a of SECURITY_EVENT_ACTIONS) counts[a] = 0;
  for (const row of byAction) counts[row._id] = row.count;
  return { count24h: total, byAction: counts, latest };
}

async function getAdminEmail() {
  const doc = await SiteConfig.findOne({ key: 'contactEmail' }).lean();
  return doc?.value || null;
}

/**
 * Cron-driven spike check. Runs every 15 min from scheduler.js.
 * Emits at most one email per spike type per COOLDOWN_MS window.
 */
async function runSecurityAlertCheck() {
  try {
    const adminEmail = await getAdminEmail();
    if (!adminEmail) {
      // No contactEmail configured; spike detection is logged but not emailed.
      // (The SuperAdmin badge still works without this.)
      return { sent: 0, reason: 'no_contact_email' };
    }

    const now = Date.now();
    const triggers = [];

    // Spike 1: too many account lockouts in a short window
    {
      const since = new Date(now - SPIKES.lockoutsPerHour.windowMs);
      const count = await AuditLog.countDocuments({
        action: SPIKES.lockoutsPerHour.action,
        timestamp: { $gte: since },
      });
      if (count >= SPIKES.lockoutsPerHour.count) {
        triggers.push({ kind: 'lockout_spike', count, threshold: SPIKES.lockoutsPerHour.count, windowMs: SPIKES.lockoutsPerHour.windowMs });
      }
    }

    // Spike 2: one user hitting rate limits over and over
    {
      const since = new Date(now - SPIKES.rateLimitHitsPerUserPerHr.windowMs);
      const top = await AuditLog.aggregate([
        { $match: { action: SPIKES.rateLimitHitsPerUserPerHr.action, timestamp: { $gte: since }, 'actor.userId': { $ne: null } } },
        { $group: { _id: '$actor.userId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ]);
      if (top.length > 0 && top[0].count >= SPIKES.rateLimitHitsPerUserPerHr.count) {
        triggers.push({
          kind: 'user_rate_limit_spike',
          userId: String(top[0]._id),
          count: top[0].count,
          threshold: SPIKES.rateLimitHitsPerUserPerHr.count,
          windowMs: SPIKES.rateLimitHitsPerUserPerHr.windowMs,
        });
      }
    }

    let sent = 0;
    for (const t of triggers) {
      const last = lastAlertAt.get(t.kind) || 0;
      if (now - last < COOLDOWN_MS) continue;
      try {
        await sendSecurityAlertEmail(adminEmail, t);
        lastAlertAt.set(t.kind, now);
        sent++;
      } catch (err) {
        console.error('[securityAlert] send failed:', err.message);
      }
    }
    return { sent, triggers };
  } catch (err) {
    console.error('[securityAlert] check failed:', err);
    return { sent: 0, error: err.message };
  }
}

module.exports = {
  SECURITY_EVENT_ACTIONS,
  getSecuritySummary,
  runSecurityAlertCheck,
  // exported for tests
  _internal: { SPIKES, COOLDOWN_MS, lastAlertAt },
};
