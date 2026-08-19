/**
 * Supporter tier definitions for Cellarion.
 *
 * Every tier is functionally identical — all features (including the daily
 * Cellar Chat allowance, see aiConfig.chatDailyLimit) are free for everyone.
 * The paid tiers are purely voluntary donations to fund development; they
 * unlock nothing extra.
 *
 * price:       monthly price in USD (0 = free)
 * annualPrice: yearly price in USD, omitted on the free tier. Display only —
 *              the amount actually charged comes from the Stripe Price whose
 *              id is in STRIPE_<TIER>_ANNUAL_PRICE_ID, so if you change one you
 *              must change the other.
 * suggested:   marks the tier the /supporter page highlights. Exactly one paid
 *              tier should carry it.
 *
 * The annual price is deliberately EXACTLY 12x the monthly one — there is no
 * yearly discount. Yearly is steered by being the default cadence and by the
 * honest framing on /supporter (one card fee a year instead of twelve, so more
 * of the gift arrives), not by asking donors to give less. The saving is the
 * fixed part of Stripe's per-charge fee: ~11x ~$0.20 ~= $2.20/subscriber/year
 * whatever the tier, which is worth ~9% at Supporter and ~2% at Benefactor.
 */
const PLANS = {
  free: {
    label: 'Enthusiast',
    description: 'Full access to every feature — completely free.',
    price: 0,
    featureList: [
      'Unlimited cellars & shared members',
      'Bottle tracking (vintages, ratings, notes)',
      'All analytics & statistics',
      'Aging & maturity profiles',
      'Price evolution tracking',
      'Wine list PDF generation',
      'Smart restock alerts',
      'Drink-window alerts',
      'Rack management',
      'Wine requests',
      'Cellar Chat',
    ],
  },
  supporter: {
    label: 'Supporter',
    description: 'Chip in to help fund development — no extra features, just our thanks.',
    price: 2,
    annualPrice: 24,
    featureList: [
      'Everything in Enthusiast (all features are free)',
      'Support independent development',
      'Our heartfelt thanks',
    ],
  },
  patron: {
    label: 'Patron',
    description: 'Support Cellarion at a higher level — no extra features, just bigger thanks.',
    price: 5,
    annualPrice: 60,
    suggested: true,
    featureList: [
      'Everything in Enthusiast (all features are free)',
      'Support independent development even more',
      'Our heartfelt thanks',
    ],
  },
  benefactor: {
    label: 'Benefactor',
    description: 'Cover a meaningful slice of the running costs — still no extra features.',
    price: 10,
    annualPrice: 120,
    featureList: [
      'Everything in Enthusiast (all features are free)',
      'Cover a real share of the monthly bills',
      'Our heartfelt thanks',
    ],
  },
};

/** All valid plan names */
const PLAN_NAMES = Object.keys(PLANS);

/**
 * Returns the plan config for a given plan name.
 * Falls back to 'free' if the plan is unknown.
 */
function getPlanConfig(plan) {
  return PLANS[plan] || PLANS.free;
}

module.exports = { PLANS, PLAN_NAMES, getPlanConfig };
