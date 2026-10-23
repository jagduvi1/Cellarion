/**
 * Owner-question emails (2026-10-20). A curator's question to the owners of a
 * wine (ownerInquiryOps.createOwnerInquiry) used to reach the bell and push
 * only, and none of 64 open questions had an answer. Every recipient now also
 * gets the question by email, unless:
 *   - mail is not configured, or the address is missing or not verified;
 *   - they unsubscribed from all Cellarion email (emailOptOutAt) or turned
 *     this category off (preferences.notifications.ownerInquiry.email);
 *   - their account is scheduled for deletion;
 *   - another question was already emailed to them in the last 24 hours. The
 *     bell still has it: someone who owns many wines of one import must not
 *     get a stack of emails in a day.
 *
 * Best-effort and bounded: the inquiry is already written and the in-app
 * notification is out, so a mail failure costs only the email. `emailedAt` on
 * the recipient row records each send; the daily cap reads it.
 */
const User = require('../models/User');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const { sendOwnerInquiryEmail, EMAIL_VERIFICATION_ENABLED } = require('./mailgun');

const EMAIL_TIMEOUT_MS = 10 * 1000;
const EMAIL_GAP_MS = 24 * 60 * 60 * 1000;
const TIMED_OUT = 'timed out';

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMED_OUT)), EMAIL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Email the question of a just-created inquiry to its recipients.
 *
 * One run at a time in this process: the daily cap reads the emailedAt stamps
 * the previous run wrote, so questions created seconds apart (a curator
 * working through one import) cannot both email the same owner. The backend
 * runs as one process, like the other in-memory state (dataVersion, the MCP
 * caches); a second process would need the claim to move to the database.
 *
 * @param {object} p
 * @param {object} p.inquiry       the created WineOwnerInquiry ({ _id, question, recipients[].user })
 * @param {string} p.wineLabel     "Producer — Name"
 * @param {string} p.questionPath  app path of the question (/questions/<id>)
 * @param {Date}   [p.now]
 * @returns {Promise<{emailed:number}>}
 */
let queue = Promise.resolve();
function emailInquiryRecipients(args) {
  const run = queue.then(() => emailOnce(args));
  queue = run.catch(() => {});
  return run;
}

async function emailOnce({ inquiry, wineLabel, questionPath, now = new Date() }) {
  if (!EMAIL_VERIFICATION_ENABLED) return { emailed: 0 };
  const ids = (inquiry?.recipients || []).map((r) => r.user).filter(Boolean);
  if (ids.length === 0) return { emailed: 0 };

  const users = await User.find({ _id: { $in: ids } })
    .select('email emailVerified emailOptOutAt isDemo deletionScheduledFor username displayName preferences.notifications.ownerInquiry')
    .lean();

  // Who already had a question emailed in the last day (by any other inquiry).
  const since = new Date(now.getTime() - EMAIL_GAP_MS);
  const recent = await WineOwnerInquiry.find({
    _id: { $ne: inquiry._id },
    recipients: { $elemMatch: { user: { $in: ids }, emailedAt: { $gt: since } } },
  }).select('recipients.user recipients.emailedAt').lean();
  const emailedToday = new Set();
  for (const doc of recent) {
    for (const r of doc.recipients || []) {
      if (r.emailedAt && new Date(r.emailedAt) > since) emailedToday.add(String(r.user));
    }
  }

  const eligible = users.filter((u) => u.email && u.emailVerified && !u.emailOptOutAt && !u.isDemo
    && !u.deletionScheduledFor
    && u.preferences?.notifications?.ownerInquiry?.email !== false
    && !emailedToday.has(String(u._id)));
  if (eligible.length === 0) return { emailed: 0 };

  const results = await Promise.allSettled(eligible.map((u) => withTimeout(sendOwnerInquiryEmail(
    u.email, u.displayName || u.username || 'there', String(u._id), wineLabel, inquiry.question, questionPath,
  ))));
  const sent = [];
  const stamped = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sent.push(eligible[i]._id);
      stamped.push(eligible[i]._id);
    } else if (r.reason?.message === TIMED_OUT) {
      // Mailgun may still deliver it: count it for the daily cap, so a later
      // question does not email the same person again within the day.
      stamped.push(eligible[i]._id);
      console.warn('Owner question email timed out (counted for the daily cap):', String(eligible[i]._id));
    } else {
      console.error('Owner question email failed:', r.reason?.message);
    }
  });

  if (stamped.length) {
    await WineOwnerInquiry.updateOne(
      { _id: inquiry._id },
      { $set: { 'recipients.$[r].emailedAt': now } },
      { arrayFilters: [{ 'r.user': { $in: stamped } }] },
    );
  }
  return { emailed: sent.length };
}

/**
 * One-time, idempotent: an account that unsubscribed from all email before
 * this category existed has no ownerInquiry flag stored, so the schema default
 * (on) showed it ticked in Settings, and saving any notification setting then
 * sent `email: true` and withdrew the unsubscribe (buildPreferencesUpdate).
 * Store the flag off for those accounts, as the unsubscribe itself now does —
 * the same repair scripts/backfill-email-opt-out.js made for support answers.
 * Run at boot (server.js); later boots find nothing to do.
 *
 * @returns {Promise<number>} accounts updated
 */
async function storeOptedOutOwnerQuestions() {
  const res = await User.updateMany(
    { emailOptOutAt: { $ne: null }, 'preferences.notifications.ownerInquiry.email': { $exists: false } },
    { $set: { 'preferences.notifications.ownerInquiry.email': false } },
  );
  return res.modifiedCount || 0;
}

module.exports = { emailInquiryRecipients, storeOptedOutOwnerQuestions, EMAIL_GAP_MS };
