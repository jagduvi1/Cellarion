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
  // An integer by the settings route's validation; forced to a number anyway,
  // since it reaches the filters below (and $eq there keeps it a literal).
  const cap = Number(cfg.aiGlobalDailyCap?.max ?? rateLimitsConfig.defaults.aiGlobalDailyCap.max);
  if (!(cap > 0)) return { sent: 0, reason: 'cap_disabled' };
  if (!mailgun.EMAIL_VERIFICATION_ENABLED) return { sent: 0, reason: 'email_disabled' };

  const date = now.toISOString().slice(0, 10);
  const row = await AiUsage.findOne({ userId: null, date }).select('count alertedPct alertedCap').lean();
  const count = row?.count || 0;
  const pct = THRESHOLDS.find((p) => count >= Math.ceil((cap * p) / 100));
  // A warning counts for the cap it was sent under only: once the cap is
  // changed (raising it is what the email suggests), the new cap's thresholds
  // warn again.
  const alreadySent = row && row.alertedCap === cap ? (row.alertedPct || 0) : 0;
  if (!pct || alreadySent >= pct) return { sent: 0 };

  const contactEmail = await getContactEmail();
  if (!contactEmail) return { sent: 0, reason: 'no_contact_email' };

  // Claim the threshold before sending: only one run gets to send it.
  const claim = await AiUsage.updateOne(
    { userId: null, date, $or: [{ alertedCap: { $ne: cap } }, { alertedPct: { $not: { $gte: pct } } }] },
    { $set: { alertedPct: pct, alertedCap: cap } },
  );
  if (claim.modifiedCount !== 1) return { sent: 0 };

  try {
    // Per-user rows exist only while the per-user budget is on (aiBudget).
    const budget = cfg.aiDailyBudget?.max ?? rateLimitsConfig.defaults.aiDailyBudget.max;
    const [topAi, topChat] = await Promise.all([
      budget > 0 ? topUsers(AiUsage, date) : null,
      topUsers(ChatUsage, date),
    ]);
    await mailgun.sendAiCapAlertEmail(contactEmail, {
      pct, count, cap, resetsInSeconds: secondsUntilMidnightUTC(now), topAi, topChat,
    });
    return { sent: 1, pct };
  } catch (err) {
    // Give the claim back so the next run tries again.
    const restore = row?.alertedPct != null && row.alertedCap != null
      ? { $set: { alertedPct: row.alertedPct, alertedCap: row.alertedCap } }
      : { $unset: { alertedPct: 1, alertedCap: 1 } };
    await AiUsage.updateOne({ userId: null, date, alertedPct: pct, alertedCap: { $eq: cap } }, restore).catch(() => {});
    console.error('[aiCapAlert] send failed:', err.message);
    return { sent: 0, reason: 'send_failed' };
  }
}

module.exports = { runAiCapAlertCheck, THRESHOLDS };
