/**
 * Frontend mirror of backend/src/config/plans.js.
 * Used to gate UI elements without extra API calls.
 * Keep in sync with the backend config.
 *
 * All tiers have full access to every feature. The only difference is
 * the Cellar Chat quota.
 */
export const PLANS = {
  free: {
    label: 'Enthusiast',
    description: 'Full access to every feature — completely free.',
    price: 0,
    chatQuota: 5,
    chatPeriod: 'weekly',
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
    chatPeriod: 'daily',
    featureList: [
      'Everything in Enthusiast',
      'Cellar Chat (50 questions / day)',
      'Support independent development',
    ],
  },
  patron: {
    label: 'Patron',
    description: 'Maximum support with unlimited Cellar Chat.',
    price: 5.5,
    chatQuota: -1,
    chatPeriod: 'daily',
    featureList: [
      'Everything in Supporter',
      'Cellar Chat (unlimited)',
      'Priority support',
    ],
  },
};

export const PLAN_NAMES = Object.keys(PLANS);

/** Returns the plan config for the given plan name, falling back to 'free'. */
export function getPlanConfig(plan) {
  return PLANS[plan] || PLANS.free;
}

/**
 * Returns a human-readable chat quota string.
 * e.g. formatChatQuota(5) => "5 / week", formatChatQuota(-1) => "Unlimited"
 */
export function formatChatQuota(n, period = 'weekly') {
  if (n === -1) return 'Unlimited';
  return `${n} / ${period === 'daily' ? 'day' : 'week'}`;
}
