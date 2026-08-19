const express = require('express');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const { logAudit } = require('../services/audit');
const { maybeSendSupporterThankYou } = require('../services/supporterThankYou');
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

/**
 * Billing intervals a checkout may request. The interval is orthogonal to the
 * tier: an annual Supporter and a monthly Supporter both get plan 'supporter',
 * so PLAN_RANK, Cellar-Cred and admin grants never need to know the cadence.
 */
const INTERVALS = ['month', 'year'];

/** Env var holding the Stripe Price ID for each (tier, interval) pair. */
const PRICE_ENV = {
  supporter: { month: 'STRIPE_SUPPORTER_PRICE_ID', year: 'STRIPE_SUPPORTER_ANNUAL_PRICE_ID' },
  patron: { month: 'STRIPE_PATRON_PRICE_ID', year: 'STRIPE_PATRON_ANNUAL_PRICE_ID' },
  benefactor: { month: 'STRIPE_BENEFACTOR_PRICE_ID', year: 'STRIPE_BENEFACTOR_ANNUAL_PRICE_ID' },
};

/**
 * Tiers checkout will accept. Derived from PRICE_ENV rather than written out
 * again — the previous hardcoded list meant a tier added above was rejected
 * with "Invalid plan" despite having prices configured.
 */
const PAID_TIERS = Object.keys(PRICE_ENV);

/**
 * Every price env var holds a COMMA-SEPARATED list: the price new checkouts
 * use, followed by any retired prices that still have live subscribers on them.
 *
 *   STRIPE_PATRON_PRICE_ID=price_current,price_retired_2026
 *
 * This matters when a price is repriced. Archiving a Price in Stripe does not
 * touch existing subscriptions — they keep renewing at the old amount forever —
 * so those renewals keep arriving as customer.subscription.updated carrying the
 * OLD price id. If that id is no longer mapped, planFromPriceId returns null and
 * the handler logs "maps to no known plan" and leaves the subscriber's plan to
 * go stale. Keeping the retired ids listed here is what grandfathers them.
 */
function priceIdsFor(plan, interval) {
  const raw = process.env[PRICE_ENV[plan]?.[interval]] || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve the Stripe Price ID new checkouts should use for a (tier, interval)
 * pair — the FIRST entry — or undefined when that combination has no price
 * configured. The annual prices are OPTIONAL — a self-hoster who only created
 * the monthly prices keeps working, and the checkout route refuses the
 * unconfigured interval rather than quietly billing a different cadence than
 * the one the user clicked.
 */
function priceIdFor(plan, interval) {
  return priceIdsFor(plan, interval)[0] || undefined;
}

/**
 * Map a Stripe Price ID → Cellarion plan name, across both billing intervals
 * AND retired prices, so a grandfathered subscriber's renewal still resolves.
 */
function planFromPriceId(priceId) {
  if (!priceId) return null;
  for (const plan of Object.keys(PRICE_ENV)) {
    for (const interval of INTERVALS) {
      if (priceIdsFor(plan, interval).includes(priceId)) return plan;
    }
  }
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

// ── GET /api/stripe/availability — which (tier, interval) pairs are buyable ──
/**
 * The /supporter page renders a button per tier per cadence, but every price is
 * an OPTIONAL env var — a self-hoster (or a prod box mid-rollout) may have only
 * some of them set. Without this the page happily renders a button that dies on
 * "Stripe price not configured" after the user has committed to giving money.
 *
 * Returns only booleans, never the Price IDs themselves.
 */
router.get('/availability', requireAuth, (req, res) => {
  const tiers = {};
  for (const tier of PAID_TIERS) {
    tiers[tier] = Object.fromEntries(
      INTERVALS.map((interval) => [interval, !!priceIdFor(tier, interval)])
    );
  }
  res.json({ configured: !!process.env.STRIPE_SECRET_KEY, tiers });
});

// ── POST /api/stripe/checkout — Create a Stripe Checkout Session ──
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { plan, interval = 'month' } = req.body;
    if (!plan || !PAID_TIERS.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    // Defaults to 'month' so an older client (or the MCP/API caller that only
    // knows about `plan`) keeps getting exactly what it got before.
    if (!INTERVALS.includes(interval)) {
      return res.status(400).json({ error: 'Invalid billing interval' });
    }

    const priceId = priceIdFor(plan, interval);
    if (!priceId) {
      // Name the missing env var in the log (never in the response) so a
      // self-hoster who only created monthly prices can diagnose this.
      console.error(`[stripe] no price configured for ${plan}/${interval} — set ${PRICE_ENV[plan][interval]}`);
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

    // Reuse existing Stripe customer or create one. Persisting the fresh
    // customer uses an atomic conditional claim so two concurrent first
    // checkouts (double-click / two tabs, both reading stripeCustomerId: null)
    // converge on ONE Stripe customer instead of the last write orphaning the
    // first — a subscription completed on an overwritten customer would be
    // invisible to /portal (scoped to the persisted id) and immune to the
    // customer.subscription.deleted reconcile, so the user could never cancel
    // it (audit 2026-07-08, L-6).
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await s.customers.create({
        email: user.email,
        metadata: { userId: user._id.toString() }
      });
      // Atomic claim: only one concurrent request can flip null → id.
      const claimed = await User.findOneAndUpdate(
        { _id: req.user.id, stripeCustomerId: null },
        { stripeCustomerId: customer.id },
        { new: true }
      );
      if (claimed) {
        customerId = customer.id;
      } else {
        // Lost the race: converge on the customer the winning request
        // persisted and discard our duplicate. Deletion is safe — the
        // duplicate is milliseconds old and cannot have a subscription yet —
        // and best-effort: a leftover subscription-less customer is harmless.
        const winner = await User.findById(req.user.id).select('stripeCustomerId');
        if (winner?.stripeCustomerId) {
          customerId = winner.stripeCustomerId;
          try {
            await s.customers.del(customer.id);
          } catch (e) {
            console.warn(`[stripe] could not delete duplicate customer ${customer.id} (harmless, no subscription):`, e.message);
          }
        } else {
          // Claim failed yet no persisted id to converge on (user deleted
          // mid-request or field cleared) — keep the fresh customer so this
          // checkout still works; there is no duplicate to clean up.
          customerId = customer.id;
        }
      }
    }

    // Defense-in-depth for the double-click / two-tab race, where the
    // checkout.session.completed webhook has not yet populated
    // stripeSubscriptionId: ask Stripe directly whether this customer already
    // has a live subscription. Runs before EVERY session creation — including
    // for a just-created/just-claimed customer, so a request that lost the
    // claim race is re-checked against the customer it converged on.
    // Best-effort — a transient API error must never block a legitimate
    // checkout.
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

    // Stripe idempotency key: a double-click / two-tab burst (same user, same
    // price, same 10-second bucket) replays the FIRST checkout session instead
    // of creating a second one, while a genuine retry minutes later gets a
    // fresh key. Safe because concurrent requests converge on one customerId
    // above, so the replayed request's params match the original's.
    const idempotencyKey = `checkout:${user._id}:${priceId}:${Math.floor(Date.now() / 10_000)}`;

    const session = await s.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/supporter?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/supporter`,
      subscription_data: {
        // `plan` stays the tier — the webhook applies it verbatim. `interval`
        // is recorded for support/analytics only; nothing entitlement-related
        // reads it, so a monthly and an annual Supporter are indistinguishable
        // to the rest of the app, which is the point.
        metadata: { userId: user._id.toString(), plan, interval }
      }
    }, { idempotencyKey });

    logAudit(req, 'stripe.checkout_created', {}, { plan, interval });
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
              // Once per account, ever — the guard lives in the service, not
              // here, because this handler also runs on redeliveries.
              await maybeSendSupporterThankYou(userId);
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
              // Covers anyone whose paid plan starts on this event rather than
              // on checkout.session.completed. This case also fires on every
              // renewal and on a supporter -> patron switch, so it leans
              // entirely on the once-ever stamp to stay quiet.
              await maybeSendSupporterThankYou(userId);
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
// planFromPriceId is what grandfathers a repriced subscriber — worth testing
// directly rather than through a webhook that needs signature verification.
module.exports.planFromPriceId = planFromPriceId;
