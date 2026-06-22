const express = require('express');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const { logAudit } = require('../services/audit');
const { PLAN_RANK } = require('../utils/cellarCred');

const router = express.Router();

// ── Stripe client (lazy — only initialised when env vars are set) ──
let stripe;
function getStripe() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    stripe = require('stripe')(key);
  }
  return stripe;
}

/** Map Stripe Price IDs → Cellarion plan names */
function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_SUPPORTER_PRICE_ID) return 'supporter';
  if (priceId === process.env.STRIPE_PATRON_PRICE_ID) return 'patron';
  return null;
}

/**
 * Apply a Stripe-granted plan WITHOUT clobbering a higher-rank or unexpired
 * non-Stripe grant (admin grants and Cellar-Cred tier rewards write the same
 * `plan`/`planExpiresAt` fields — see utils/cellarCred.js, which already uses
 * this max-rank guard). The Stripe subscription id is always recorded so a
 * later cancellation can be matched to it.
 *
 * @returns {object} the audit-friendly { from, to } plan transition
 */
async function applyStripePlan(userId, plan, subscriptionId) {
  const user = await User.findById(userId).select('plan planExpiresAt');
  if (!user) return null;

  const currentRank = PLAN_RANK[user.plan] ?? 0;
  const newRank = PLAN_RANK[plan] ?? 0;
  const planExpired = user.planExpiresAt && new Date(user.planExpiresAt) < new Date();

  // A Stripe-granted plan always leaves planExpiresAt null (set below); a
  // time-limited admin / Cellar-Cred grant sets planExpiresAt in the future. So
  // an UNEXPIRED planExpiresAt is the only thing that should hold off this
  // webhook — and only while that grant outranks the incoming Stripe plan. When
  // the current plan is itself the Stripe entitlement (planExpiresAt null), the
  // webhook is authoritative for the user's own subscription and MUST honour a
  // paid-tier DOWNGRADE (patron → supporter), not only an upgrade. The previous
  // `newRank >= currentRank` guard silently dropped every downgrade, leaving the
  // user on the higher tier they no longer pay for.
  const activeGrantOutranks = !!user.planExpiresAt && !planExpired && currentRank > newRank;

  const update = { stripeSubscriptionId: subscriptionId };
  if (!activeGrantOutranks) {
    update.plan = plan;
    // Stamp the start only on a real change/re-activation, not on every routine
    // subscription.updated (renewals, payment-method changes) — planStartedAt
    // is a display value and shouldn't jump on each webhook.
    if (plan !== user.plan || planExpired) update.planStartedAt = new Date();
    update.planExpiresAt = null; // an active subscription has no expiry
  }
  await User.findByIdAndUpdate(userId, update);
  return { from: user.plan, to: update.plan || user.plan };
}

// ── POST /api/stripe/checkout — Create a Stripe Checkout Session ──
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !['supporter', 'patron'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const priceId = plan === 'supporter'
      ? process.env.STRIPE_SUPPORTER_PRICE_ID
      : process.env.STRIPE_PATRON_PRICE_ID;

    if (!priceId) {
      return res.status(500).json({ error: 'Stripe price not configured for this plan' });
    }

    const user = await User.findById(req.user.id).select('email stripeCustomerId stripeSubscriptionId');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Guard against a second concurrent subscription (double-billing). A user
    // who already has an active subscription must change plans through the
    // Customer Portal, where Stripe enforces one subscription per customer and
    // handles proration. Creating another Checkout Session here would bill the
    // card twice and orphan the first subscription — applyStripePlan overwrites
    // stripeSubscriptionId on the next checkout.session.completed, so the first
    // sub's later cancellation no longer matches and never downgrades the user.
    if (user.stripeSubscriptionId) {
      return res.status(409).json({
        error: 'You already have an active subscription. Use the billing portal to change your plan.',
        code: 'subscription_exists'
      });
    }

    const s = getStripe();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // Reuse existing Stripe customer or create one
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await s.customers.create({
        email: user.email,
        metadata: { userId: user._id.toString() }
      });
      customerId = customer.id;
      await User.findByIdAndUpdate(req.user.id, { stripeCustomerId: customerId });
    } else {
      // Defense-in-depth for the double-click / two-tab race, where the
      // checkout.session.completed webhook has not yet populated
      // stripeSubscriptionId: ask Stripe directly whether this customer already
      // has a live subscription. Best-effort — a transient API error must never
      // block a legitimate first checkout.
      try {
        const existing = await s.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
        const hasLive = existing.data.some((sub) =>
          ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status));
        if (hasLive) {
          return res.status(409).json({
            error: 'You already have an active subscription. Use the billing portal to change your plan.',
            code: 'subscription_exists'
          });
        }
      } catch (e) {
        console.warn('[stripe] could not verify existing subscriptions (proceeding):', e.message);
      }
    }

    const session = await s.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/supporter?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/supporter`,
      subscription_data: {
        metadata: { userId: user._id.toString(), plan }
      }
    });

    logAudit(req, 'stripe.checkout_created', { plan });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout error:', error.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── POST /api/stripe/portal — Create a Stripe Customer Portal session ──
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('stripeCustomerId');
    if (!user?.stripeCustomerId) {
      return res.status(400).json({ error: 'No active subscription' });
    }

    const s = getStripe();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const session = await s.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${frontendUrl}/supporter`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe portal error:', error.message);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// ── POST /api/stripe/webhook — Stripe webhook (raw body required) ──
// Body parsing is handled in app.js with express.raw() before this route.
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.error('[stripe] STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err.message);
    // Generic message to caller — Stripe's own error strings can leak which
    // part of the verification failed (timestamp tolerance vs. signature
    // mismatch). Log the detail server-side instead.
    return res.status(400).json({ error: 'Invalid webhook' });
  }

  // Idempotency: claim this event.id via a unique index before handling it.
  // A duplicate-key error means Stripe already delivered this event and we
  // processed it — ack with 200 and skip so a redelivery can't re-apply a
  // plan change. A non-duplicate DB error shouldn't block billing, so we log
  // it and fall through to handle the event (claimed stays false).
  let claimed = false;
  try {
    await StripeWebhookEvent.create({ eventId: event.id, type: event.type });
    claimed = true;
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ received: true, duplicate: true });
    }
    console.error('[stripe] idempotency record failed (handling anyway):', err.message);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await getStripe().subscriptions.retrieve(session.subscription);
          const userId = sub.metadata?.userId;
          const plan = sub.metadata?.plan;
          if (userId && plan) {
            const change = await applyStripePlan(userId, plan, sub.id);
            if (change) {
              logAudit(null, 'stripe.plan.changed', { type: 'user', id: userId },
                { event: 'checkout.session.completed', eventId: event.id, ...change });
              console.log(`[stripe] User ${userId} subscribed to ${plan} (effective: ${change.to})`);
            }
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (!userId) break;

        if (sub.status === 'active') {
          const priceId = sub.items?.data?.[0]?.price?.id;
          const plan = planFromPriceId(priceId);
          if (plan) {
            const change = await applyStripePlan(userId, plan, sub.id);
            if (change) {
              logAudit(null, 'stripe.plan.changed', { type: 'user', id: userId },
                { event: 'customer.subscription.updated', eventId: event.id, ...change });
            }
          } else {
            // Active subscription whose price doesn't map to any known plan —
            // a price-list drift or misconfigured env var. Surface it instead
            // of silently leaving the user on a stale plan.
            console.warn(`[stripe] Active subscription ${sub.id} for user ${userId} maps to no known plan (price ${sub.items?.data?.[0]?.price?.id})`);
          }
        } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
          // Keep current plan but log the issue
          console.warn(`[stripe] Subscription ${sub.id} for user ${userId} is ${sub.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (!userId) break;

        // Reconcile rather than blindly downgrade. Only revoke entitlement when
        // THIS Stripe subscription is the one currently in effect, and preserve
        // an unexpired non-Stripe grant (admin / Cellar-Cred set planExpiresAt
        // in the future; an active Stripe plan keeps it null). This prevents a
        // cancelled/failed card from wiping an admin-granted or earned plan,
        // and a stale redelivery after a re-subscribe from downgrading the
        // newer subscription.
        const user = await User.findById(userId).select('plan planExpiresAt stripeSubscriptionId');
        if (!user) break;

        if (user.stripeSubscriptionId !== sub.id) {
          console.log(`[stripe] Ignoring deletion of ${sub.id} for user ${userId} — current sub is ${user.stripeSubscriptionId || 'none'}`);
          break;
        }

        const hasUnexpiredGrant = user.planExpiresAt && new Date(user.planExpiresAt) > new Date();
        const update = { stripeSubscriptionId: null };
        if (!hasUnexpiredGrant) {
          update.plan = 'free';
          update.planExpiresAt = null;
        }
        await User.findByIdAndUpdate(userId, update);
        logAudit(null, 'stripe.plan.changed', { type: 'user', id: userId },
          { event: 'customer.subscription.deleted', eventId: event.id, from: user.plan, to: update.plan || user.plan });
        console.log(`[stripe] User ${userId} subscription ${sub.id} cancelled (plan now: ${update.plan || user.plan})`);
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err) {
    console.error(`[stripe] Error handling ${event.type}:`, err.message);
    // The handler did not complete (transient Stripe-API or DB error). Roll
    // back the idempotency claim so a Stripe retry — or a manual dashboard
    // replay — can reprocess this event, and return 5xx to actually trigger
    // that retry. Leaving the claim in place + a 200 here would permanently
    // lose the event (the dedup row would short-circuit every redelivery).
    if (claimed) {
      await StripeWebhookEvent.deleteOne({ eventId: event.id }).catch(() => {});
    }
    return res.status(500).json({ error: 'Webhook handler failed' });
  }

  res.json({ received: true });
});

module.exports = router;
// Exported for unit tests (the webhook handlers above are exercised in Docker).
module.exports.applyStripePlan = applyStripePlan;
