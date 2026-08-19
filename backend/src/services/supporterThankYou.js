const User = require('../models/User');
const { sendSupporterThankYou, EMAIL_VERIFICATION_ENABLED } = require('./mailgun');
const { logAudit } = require('./audit');

const { PLANS, PLAN_NAMES } = require('../config/plans');

const PAID_PLANS = PLAN_NAMES.filter((p) => PLANS[p].price > 0);

/**
 * Thank a user for taking out a paid plan — at most once per account, ever.
 *
 * The plan webhook is not a "they just subscribed" signal: applyStripePlan runs
 * on every customer.subscription.updated, which includes renewals, payment
 * method changes and tier switches, and Stripe redelivers events on its own
 * schedule. So the only durable answer to "have we already thanked them" is the
 * stamp on the user, and a supporter who later upgrades to patron must not be
 * thanked a second time.
 *
 * The stamp is claimed BEFORE the send, atomically. Under a redelivery two
 * handlers can run concurrently; whichever matches `supporterThankYouSentAt:
 * null` first wins and the other no-ops. The cost of that ordering is that a
 * send which fails after the claim is never retried — deliberate, because a
 * duplicate thank-you is more embarrassing to the sender than a missing one,
 * and the failure is logged loudly enough to send by hand.
 *
 * Never throws: this runs off a billing webhook and a mail problem must never
 * fail a payment.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<boolean>} true if an email was actually sent
 */
async function maybeSendSupporterThankYou(userId) {
  try {
    // Checked BEFORE claiming. If mail is not configured (the default for a
    // self-hosted install), claiming would burn the one chance this account
    // ever gets — the stamp would say "thanked" for a mail that never left.
    if (!EMAIL_VERIFICATION_ENABLED) return false;

    const claimed = await User.findOneAndUpdate(
      { _id: userId, plan: { $in: PAID_PLANS }, supporterThankYouSentAt: null },
      { $set: { supporterThankYouSentAt: new Date() } },
      { new: false }
    ).select('email username plan');

    if (!claimed) return false;          // already thanked, not paid, or gone
    if (!claimed.email) return false;

    await sendSupporterThankYou(claimed.email, claimed.username, claimed.plan);

    logAudit(null, 'supporter.thank_you_sent', { type: 'user', id: claimed._id }, { plan: claimed.plan });
    return true;
  } catch (err) {
    // The stamp is already set at this point, so this will not retry. Loud on
    // purpose: the follow-up is to send that one by hand.
    console.error(`[supporterThankYou] send FAILED for user ${userId} — stamp is set, will NOT retry:`, err.message);
    return false;
  }
}

module.exports = { maybeSendSupporterThankYou, PAID_PLANS };
