/**
 * Owner-question emails (2026-10-20). A curator's question to the owners of a
 * wine (ownerInquiryOps.createOwnerInquiry) used to reach the bell and push
 * only, and none of 64 open questions had an answer. Every recipient now also
 * gets the question by email, unless:
 *   - mail is not configured, or the address is missing or not verified;
 *   - they unsubscribed from all Cellarion email (emailOptOutAt) or turned
 *     this category off (preferences.notifications.ownerInquiry.email);
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

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), EMAIL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Email the question of a just-created inquiry to its recipients.
 *
 * @param {object} p
 * @param {object} p.inquiry       the created WineOwnerInquiry ({ _id, question, recipients[].user })
 * @param {string} p.wineLabel     "Producer — Name"
 * @param {string} p.questionPath  app path of the question (/questions/<id>)
 * @param {Date}   [p.now]
 * @returns {Promise<{emailed:number}>}
 */
async function emailInquiryRecipients({ inquiry, wineLabel, questionPath, now = new Date() }) {
  if (!EMAIL_VERIFICATION_ENABLED) return { emailed: 0 };
  const ids = (inquiry?.recipients || []).map((r) => r.user).filter(Boolean);
  if (ids.length === 0) return { emailed: 0 };

  const users = await User.find({ _id: { $in: ids } })
    .select('email emailVerified emailOptOutAt isDemo username displayName preferences.notifications.ownerInquiry')
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
    && u.preferences?.notifications?.ownerInquiry?.email !== false
    && !emailedToday.has(String(u._id)));
  if (eligible.length === 0) return { emailed: 0 };

  const results = await Promise.allSettled(eligible.map((u) => withTimeout(sendOwnerInquiryEmail(
    u.email, u.displayName || u.username || 'there', String(u._id), wineLabel, inquiry.question, questionPath,
  ))));
  const sent = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sent.push(eligible[i]._id);
    else console.error('Owner question email failed:', r.reason?.message);
  });

  if (sent.length) {
    await WineOwnerInquiry.updateOne(
      { _id: inquiry._id },
      { $set: { 'recipients.$[r].emailedAt': now } },
      { arrayFilters: [{ 'r.user': { $in: sent } }] },
    );
  }
  return { emailed: sent.length };
}

module.exports = { emailInquiryRecipients, EMAIL_GAP_MS };
