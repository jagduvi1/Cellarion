/**
 * Early warning before the site-wide daily AI cap is reached (scaling audit
 * 2026-09-25, item 5).
 *
 * At the cap (rateLimits.aiGlobalDailyCap) every AI feature switches off for
 * everyone until 00:00 UTC. This emails the site contact address the first
 * time today's count reaches 50%, 80% and 100% of the cap, once per threshold
 * per UTC day. That leaves time to see whether it is abuse, one big import or
 * real growth, and to raise the cap before anyone notices.
 *
 * Which threshold was already sent is stored on the day's global counter row
 * (AiUsage, userId null) and claimed with one conditional update, so neither a
 * restart nor a second process sends the same warning twice.
 */

const AiUsage = require('../models/AiUsage');
const ChatUsage = require('../models/ChatUsage');
const SiteConfig = require('../models/SiteConfig');
const rateLimitsConfig = require('../config/rateLimits');
const { secondsUntilMidnightUTC } = require('./aiBudget');
const mailgun = require('./mailgun');

// Highest first: when several are crossed between two runs, one email names
// the highest share reached.
const THRESHOLDS = [100, 80, 50];

async function getContactEmail() {
  const doc = await SiteConfig.findOne({ key: 'contactEmail' }).lean();
  return doc?.value || null;
}

// The accounts behind most of today's calls, so the email already answers
// "one account or everyone?". User ids only.
async function topUsers(Model, date) {
  const rows = await Model.find({ date, userId: { $ne: null }, count: { $gt: 0 } })
    .sort({ count: -1 })
    .limit(3)
    .select('userId count')
    .lean();
  return rows.map((r) => ({ userId: String(r.userId), count: r.count }));
}

/**
 * Cron-driven (scheduler.js, every 15 minutes). Returns { sent, pct? , reason? }.
 */
async function runAiCapAlertCheck(now = new Date()) {
  const cfg = rateLimitsConfig.get();
  const cap = cfg.aiGlobalDailyCap?.max ?? rateLimitsConfig.defaults.aiGlobalDailyCap.max;
  if (!(cap > 0)) return { sent: 0, reason: 'cap_disabled' };
  if (!mailgun.EMAIL_VERIFICATION_ENABLED) return { sent: 0, reason: 'email_disabled' };

  const date = now.toISOString().slice(0, 10);
  const row = await AiUsage.findOne({ userId: null, date }).select('count alertedPct').lean();
  const count = row?.count || 0;
  const pct = THRESHOLDS.find((p) => count >= Math.ceil((cap * p) / 100));
  if (!pct || (row.alertedPct || 0) >= pct) return { sent: 0 };

  const contactEmail = await getContactEmail();
  if (!contactEmail) return { sent: 0, reason: 'no_contact_email' };

  // Claim the threshold before sending: only one run gets to send it.
  const claim = await AiUsage.updateOne(
    { userId: null, date, alertedPct: { $not: { $gte: pct } } },
    { $set: { alertedPct: pct } },
  );
  if (claim.modifiedCount !== 1) return { sent: 0 };

  try {
    const [topAi, topChat] = await Promise.all([topUsers(AiUsage, date), topUsers(ChatUsage, date)]);
    await mailgun.sendAiCapAlertEmail(contactEmail, {
      pct, count, cap, resetsInSeconds: secondsUntilMidnightUTC(now), topAi, topChat,
    });
    return { sent: 1, pct };
  } catch (err) {
    // Give the claim back so the next run tries again.
    const previous = row.alertedPct;
    await AiUsage.updateOne(
      { userId: null, date, alertedPct: pct },
      previous ? { $set: { alertedPct: previous } } : { $unset: { alertedPct: 1 } },
    ).catch(() => {});
    console.error('[aiCapAlert] send failed:', err.message);
    return { sent: 0, reason: 'send_failed' };
  }
}

module.exports = { runAiCapAlertCheck, THRESHOLDS };
