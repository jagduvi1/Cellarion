/**
 * Recommendation external-email retention scrub — runs daily via the scheduler.
 *
 * `Recommendation.recipientEmail` holds a NON-USER third party's address (the
 * subject has no account, never consented, and has no Art. 17/21 mechanism of
 * their own), so it must not be retained indefinitely (security audit L-15,
 * GDPR data minimisation / storage limitation). After the recommendation email
 * is dispatched the address serves exactly one purpose: showing the sender who
 * their "sent" recommendation went to. So instead of deleting the user-visible
 * recommendation document, this job blanks just the email once the document is
 * older than the retention window — the same 90 days the PendingShare and
 * Notification TTLs promise for comparable data.
 *
 * The per-user daily send cap in routes/recommendations.js only counts
 * documents from the last 24 h with a non-null recipientEmail, so a 90-day
 * scrub never affects it. Sender-account erasure scrubs the field immediately
 * regardless of age (userDataRegistry.js).
 */
const Recommendation = require('../models/Recommendation');

const RECIPIENT_EMAIL_RETENTION_DAYS = 90;

async function runRecommendationEmailScrub() {
  const cutoff = new Date(Date.now() - RECIPIENT_EMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await Recommendation.updateMany(
    { recipientEmail: { $ne: null }, createdAt: { $lt: cutoff } },
    { $unset: { recipientEmail: '' } }
  );
  const scrubbed = result.modifiedCount || 0;
  if (scrubbed > 0) {
    console.log(
      `[recommendationRetention] Scrubbed external recipientEmail from ${scrubbed} ` +
      `recommendation(s) older than ${RECIPIENT_EMAIL_RETENTION_DAYS} days`
    );
  }
  return { scrubbed };
}

module.exports = { runRecommendationEmailScrub, RECIPIENT_EMAIL_RETENTION_DAYS };
