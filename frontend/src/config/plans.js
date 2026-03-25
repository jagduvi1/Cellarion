/**
 * Frontend mirror of backend/src/config/plans.js.
 * Used to gate UI elements without extra API calls.
 * Keep in sync with the backend config.
 */
export const PLANS = {
  free: {
    label: 'Free',
    description: 'Get started with wine tracking at no cost.',
    maxCellars: 1,
    maxSharesPerCellar: 1,
    features: {
      agingMaturity: true,
      priceEvolution: false,
    },
    featureList: [
      '1 cellar',
      '1 shared member per cellar',
      'Bottle tracking (vintages, ratings, notes)',
      'Aging & maturity profiles',
      'Drink-window alerts',
      'Rack management',
      'Wine requests',
      'Basic stats: wine types, maturity status, rating distribution',
      'Cellar Chat (5 questions / week)',
    ],
  },
  basic: {
    label: 'Basic',
    description: 'More space to grow your collection.',
    maxCellars: 5,
    maxSharesPerCellar: 1,
    features: {
      agingMaturity: true,
      priceEvolution: false,
    },
    featureList: [
      '5 cellars',
      '1 shared member per cellar',
      'Everything in Free',
      'Full analytics: vintage charts, world map, regions, producers',
      'Consumption history & cellar pace',
      'Cellar Chat (20 questions / day)',
    ],
  },
  premium: {
    label: 'Premium',
    description: 'Unlimited access and advanced analytics.',
    maxCellars: -1,  // -1 = unlimited
    maxSharesPerCellar: -1,
    features: {
      agingMaturity: true,
      priceEvolution: true,
    },
    featureList: [
      'Unlimited cellars',
      'Unlimited shared members per cellar',
      'Price evolution tracking',
      'Everything in Basic',
      'Cellar health score & Regret Index',
      'Urgency ladder, drink window forecast',
      'Joy Per Dollar, Patience Payoff, Expectation vs Reality',
      'Collection value & most valuable bottles',
      'Cellar Chat (50 questions / day)',
    ],
  },
};

export const PLAN_NAMES = Object.keys(PLANS);

/** Returns the plan config for the given plan name, falling back to 'free'. */
export function getPlanConfig(plan) {
  return PLANS[plan] || PLANS.free;
}

/** Returns true if the given plan grants the named feature. */
export function planHasFeature(plan, featureName) {
  const config = getPlanConfig(plan);
  return config.features[featureName] === true;
}

/**
 * Returns a human-readable limit string.
 * e.g. formatLimit(1) => "1", formatLimit(-1) => "Unlimited"
 */
export function formatLimit(n) {
  return n === -1 ? 'Unlimited' : String(n);
}
