const PendingShare = require('../models/PendingShare');
const { revokeAllSessions } = require('./authTokens');
const eventBus = require('./eventBus');
const { logAudit } = require('./audit');

const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Schedule an account for deletion in 7 days. Shared by DELETE /api/users/me
 * (Settings) and the "delete my account" email link, so both do exactly the
 * same thing: cancel a live Stripe subscription, sign out every device, drop
 * the account's pending cellar invites and write `user.deletion_requested`.
 * The person cancels by logging in before the date (Settings → Delete account);
 * services/userDeletionJob does the actual purge.
 *
 * `user` is a full (non-lean) User document that is not already scheduled.
 * `auditDetail` lands on the audit row (the email link passes { via }).
 * Returns the deletion date.
 */
async function scheduleAccountDeletion(user, req, auditDetail = {}) {
  const now = new Date();
  const scheduledFor = new Date(now.getTime() + DELETION_GRACE_MS);

  if (user.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(user.stripeSubscriptionId);
      user.stripeSubscriptionId = null;
      user.plan = 'free';
    } catch (stripeErr) {
      console.error('Failed to cancel Stripe subscription during deletion:', stripeErr.message);
    }
  }

  user.deletionRequestedAt = now;
  user.deletionScheduledFor = scheduledFor;
  // Revoke every device session on the deletion request so a refresh token
  // captured before deletion can't keep minting access tokens through the
  // 7-day window. The user simply re-authenticates to use the account (or to
  // cancel the deletion) — matching change-password / password-reset.
  revokeAllSessions(user);
  eventBus.dropUser(user._id); // and force-close open SSE event streams
  await user.save();

  // Clean up pending cellar invites sent by this user
  PendingShare.deleteMany({ invitedBy: user._id }).catch(() => {});

  logAudit(req, 'user.deletion_requested', { type: 'user', id: user._id }, auditDetail);

  return scheduledFor;
}

module.exports = { scheduleAccountDeletion, DELETION_GRACE_MS };
