/**
 * Plan definitions for Cellarion subscription tiers.
 *
 * maxCellars:         max owned cellars; -1 = unlimited
 * maxSharesPerCellar: max members per cellar; -1 = unlimited
 * features:           boolean feature flags for gated functionality
 */
const PLANS = {
  free: {
    maxCellars: 1,
    maxSharesPerCellar: 1,
    features: {
      priceEvolution: false,
    },
  },
  basic: {
    maxCellars: 5,
    maxSharesPerCellar: 5,
    features: {
      priceEvolution: false,
    },
  },
  premium: {
    maxCellars: -1,
    maxSharesPerCellar: -1,
    features: {
      priceEvolution: true,
    },
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
