const mongoose = require('mongoose');

/**
 * Idempotency ledger for processed Stripe webhook events.
 *
 * Stripe delivers events at-least-once and will redeliver on timeout, so the
 * same `event.id` can arrive more than once. We record each id with a unique
 * index and treat a duplicate insert as "already handled" — short-circuiting
 * before the handler runs again. This prevents a redelivered stale event
 * (e.g. a late `customer.subscription.deleted` after a re-subscribe) from
 * re-applying a plan change, and stops `checkout.session.completed` from
 * resetting planStartedAt on every replay.
 *
 * A TTL index expires rows after 30 days — long past Stripe's retry window —
 * so the collection stays small.
 */
const stripeWebhookEventSchema = new mongoose.Schema({
  eventId: {
    type: String,
    required: true,
    unique: true
  },
  type: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24 * 30 // 30-day TTL
  }
});

module.exports = mongoose.model('StripeWebhookEvent', stripeWebhookEventSchema);
