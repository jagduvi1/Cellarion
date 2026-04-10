const express = require('express');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const { logAudit } = require('../services/audit');

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

    const user = await User.findById(req.user.id).select('email stripeCustomerId');
    if (!user) return res.status(404).json({ error: 'User not found' });

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
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
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
            await User.findByIdAndUpdate(userId, {
              plan,
              planStartedAt: new Date(),
              planExpiresAt: null,
              stripeSubscriptionId: sub.id
            });
            console.log(`[stripe] User ${userId} upgraded to ${plan}`);
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
            await User.findByIdAndUpdate(userId, {
              plan,
              planExpiresAt: null,
              stripeSubscriptionId: sub.id
            });
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
        if (userId) {
          await User.findByIdAndUpdate(userId, {
            plan: 'free',
            planExpiresAt: null,
            stripeSubscriptionId: null
          });
          console.log(`[stripe] User ${userId} downgraded to free (subscription cancelled)`);
        }
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err) {
    console.error(`[stripe] Error handling ${event.type}:`, err.message);
    // Still return 200 so Stripe doesn't retry
  }

  res.json({ received: true });
});

module.exports = router;
