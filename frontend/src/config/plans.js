/**
 * Frontend mirror of backend/src/config/plans.js: the tiers' names,
 * descriptions and prices, for the pages that show them. Nothing is gated
 * by a tier. Keep in sync with the backend config.
 *
 * Every tier is functionally identical — all features (including the daily
 * Cellar Chat allowance) are free for everyone. The paid tiers are purely
 * voluntary donations to fund development; they unlock nothing extra.
 *
 * `annualPrice` is the yearly figure shown when the billing toggle is set to
 * yearly. It is display only — the charged amount comes from the Stripe Price
 * behind STRIPE_<TIER>_ANNUAL_PRICE_ID on the backend. It is exactly 12x the
 * monthly price: there is no yearly discount, only the honest "one card fee
 * instead of twelve" framing. See the backend config for the fee arithmetic.
 *
 * No tier is flagged as recommended. All three are presented as equals and the
 * middle amount is simply in the middle — a "Suggested" badge reads as an
 * expectation to pay, and nothing here is expected.
 */
export const PLANS = {
  free: {
    label: 'Enthusiast',
    description: 'Full access to every feature — completely free.',
    price: 0,
  },
  supporter: {
    label: 'Supporter',
    description: 'Chip in to help fund development — no extra features, just our thanks.',
    price: 2,
    annualPrice: 24,
  },
  patron: {
    label: 'Patron',
    description: 'Support Cellarion at a higher level — no extra features, just bigger thanks.',
    price: 5,
    annualPrice: 60,
  },
  benefactor: {
    label: 'Benefactor',
    description: 'Cover a meaningful slice of the running costs — still no extra features.',
    price: 10,
    annualPrice: 120,
  },
};

export const PLAN_NAMES = Object.keys(PLANS);

/**
 * Paid tiers in ladder order — the order the /supporter page renders them in.
 * Derived from PLANS so adding a tier to the config is enough.
 */
export const PAID_PLAN_NAMES = PLAN_NAMES.filter((p) => PLANS[p].price > 0);

/**
 * The plan's name in the reader's language. `label` stays the English name
 * (the backend mirror and the help text use it). The keys are the ones the
 * supporter badge shows, so a tier carries one name everywhere.
 */
export function planName(plan, t) {
  const key = PLANS[plan] ? plan : 'free';
  return t(`cellarCred.plan_${key}`, PLANS[key].label);
}

/** The plan's one-line description in the reader's language. */
export function planDescription(plan, t) {
  const key = PLANS[plan] ? plan : 'free';
  return t(`plans.description.${key}`, PLANS[key].description);
}
