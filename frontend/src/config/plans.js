/**
 * Frontend mirror of backend/src/config/plans.js.
 * Used to gate UI elements without extra API calls.
 * Keep in sync with the backend config.
 *
 * Every tier is functionally identical — all features (including the daily
 * Cellar Chat allowance) are free for everyone. The paid tiers are purely
 * voluntary donations to fund development; they unlock nothing extra.
 *
 * `annualPrice` is the yearly figure shown when the billing toggle is set to
 * yearly. It is display only — the charged amount comes from the Stripe Price
 * behind STRIPE_<TIER>_ANNUAL_PRICE_ID on the backend.
 */
export const PLANS = {
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

export const PLAN_NAMES = Object.keys(PLANS);

/** Returns the plan config for the given plan name, falling back to 'free'. */
export function getPlanConfig(plan) {
  return PLANS[plan] || PLANS.free;
}
