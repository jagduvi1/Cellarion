/**
 * User deletion job — runs daily via the scheduler.
 *
 * Finds users whose 7-day cooling-off period has expired and permanently
 * deletes their accounts. The erasure of every user-linked model lives in
 * services/userDataRegistry.js (the single source of truth shared with the
 * data-export route), so deletion and export can never drift apart.
 */
const User = require('../models/User');
const { purgeUserData } = require('./userDataRegistry');

// Lazy, memoised Stripe client — only needed when a deleted user had a customer.
let _stripe;
function getStripe() {
  if (!_stripe) _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

/**
 * Delete the user's Stripe customer object at final erasure (it holds their
 * email + userId metadata). Best-effort: a Stripe error must not block the
 * account deletion, and we only attempt it when Stripe is actually configured.
 */
async function deleteStripeCustomer(customerId) {
  if (!customerId || !process.env.STRIPE_SECRET_KEY) return;
  try {
    await getStripe().customers.del(customerId);
    console.log(`[user-deletion] Deleted Stripe customer ${customerId}`);
  } catch (err) {
    console.error(`[user-deletion] Failed to delete Stripe customer ${customerId}:`, err.message);
  }
}

async function runUserDeletionJob() {
  const now = new Date();

  const usersToDelete = await User.find({
    deletionScheduledFor: { $lte: now, $ne: null }
  }).select('_id email stripeCustomerId').lean();

  if (usersToDelete.length === 0) return;

  console.log(`[user-deletion] Processing ${usersToDelete.length} scheduled deletion(s)…`);

  for (const user of usersToDelete) {
    try {
      await purgeUserData(user._id, user.email);
      await deleteStripeCustomer(user.stripeCustomerId);
      await User.deleteOne({ _id: user._id });
      console.log(`[user-deletion] Deleted user ${user._id}`);
    } catch (err) {
      console.error(`[user-deletion] Failed to delete user ${user._id}:`, err);
    }
  }

  console.log(`[user-deletion] Completed ${usersToDelete.length} deletion(s)`);
}

// Re-exported for backward compatibility with existing importers.
module.exports = { runUserDeletionJob, purgeUserData };
