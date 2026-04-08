/**
 * Supporter tier definitions for Cellarion.
 *
 * All tiers have full access to every feature. The only difference is
 * the Cellar Chat quota (questions per rolling 7-day window).
 *
 * chatQuota: max chat questions per 7-day rolling window; -1 = unlimited
 * price:     monthly price in USD (0 = free)
 */
const PLANS = {
  free: {
    label: 'Enthusiast',
    description: 'Full access to every feature — completely free.',
    price: 0,
    chatQuota: 5,
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
      'Cellar Chat (5 questions / week)',
    ],
  },
  supporter: {
    label: 'Supporter',
    description: 'Support Cellarion and get more Cellar Chat.',
    price: 1.5,
    chatQuota: 50,
    featureList: [
      'Everything in Enthusiast',
      'Cellar Chat (50 questions / week)',
      'Support independent development',
    ],
  },
  patron: {
    label: 'Patron',
    description: 'Maximum support with unlimited Cellar Chat.',
    price: 5.5,
    chatQuota: -1,
    featureList: [
      'Everything in Supporter',
      'Cellar Chat (unlimited)',
      'Priority support',
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
