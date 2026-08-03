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
    price: 1.5,
    annualPrice: 18,
    featureList: [
      'Everything in Enthusiast (all features are free)',
      'Support independent development',
      'Our heartfelt thanks',
    ],
  },
  patron: {
    label: 'Patron',
    description: 'Support Cellarion at a higher level — no extra features, just bigger thanks.',
    price: 5.5,
    annualPrice: 66,
    featureList: [
      'Everything in Enthusiast (all features are free)',
      'Support independent development even more',
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
