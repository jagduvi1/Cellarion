/**
 * Plan definitions for Cellarion subscription tiers.
 *
 * maxCellars:         max owned cellars; -1 = unlimited
 * maxSharesPerCellar: max members per cellar; -1 = unlimited
 * features:           boolean feature flags for gated functionality
 * description:        short human-readable summary of the plan
 * featureList:        ordered list of features displayed on the Plans page
 */
const PLANS = {
  free: {
    description: 'Get started with wine tracking at no cost.',
    maxCellars: 1,
    maxSharesPerCellar: 1,
    features: {
      agingMaturity: false,
      priceEvolution: false,
    },
    featureList: [
      '1 cellar',
      '1 shared member per cellar',
      'Bottle tracking (vintages, ratings, notes)',
      'Drink-window alerts',
      'Rack management',
      'Wine requests',
    ],
  },
  basic: {
    description: 'More space to grow your collection.',
    maxCellars: 5,
    maxSharesPerCellar: 1,
    features: {
      agingMaturity: false,
      priceEvolution: false,
    },
    featureList: [
      '5 cellars',
      '1 shared member per cellar',
      'Everything in Free',
    ],
  },
  premium: {
    description: 'Unlimited access and advanced analytics.',
    maxCellars: -1,
    maxSharesPerCellar: -1,
    features: {
      agingMaturity: true,
      priceEvolution: true,
    },
    featureList: [
      'Unlimited cellars',
      'Unlimited shared members per cellar',
      'Aging & maturity profiles',
      'Price evolution tracking',
      'Everything in Basic',
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

/**
 * Returns true if the given plan has access to the named feature.
 */
function planHasFeature(plan, featureName) {
  const config = getPlanConfig(plan);
  return config.features[featureName] === true;
}

/**
 * Returns the first plan (by tier order) that grants the feature.
 */
function getRequiredPlanForFeature(featureName) {
  for (const name of PLAN_NAMES) {
    if (PLANS[name].features[featureName]) return name;
  }
  return null;
}

module.exports = { PLANS, PLAN_NAMES, getPlanConfig, planHasFeature, getRequiredPlanForFeature };
