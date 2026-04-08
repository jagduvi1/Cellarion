/**
 * Cellar Cred — contribution score and badge system.
 *
 * Users earn points for approved contributions (wine requests, images,
 * reviews, forum activity). Points accumulate into tiers that unlock
 * temporary plan upgrades and display badges on profiles and posts.
 */

const User = require('../models/User');

// ── Point values per event ──────────────────────────────────────────────────
const POINT_VALUES = {
  wine_request_approved:    10,
  grape_suggestion_approved: 5,
  wine_report_resolved:      5,
  image_approved:            8,
  image_assigned_official:  15,
  review_created_public:     3,
  review_like_received:      1,
  discussion_created:        2,
  discussion_reply_created:  1,
  reply_like_received:       1,
};

// ── Event → category mapping ────────────────────────────────────────────────
const CATEGORY_MAP = {
  wine_request_approved:    'curator',
  grape_suggestion_approved:'curator',
  wine_report_resolved:     'curator',
  image_approved:           'photographer',
  image_assigned_official:  'photographer',
  review_created_public:    'critic',
  review_like_received:     'critic',
  discussion_created:       'community',
  discussion_reply_created: 'community',
  reply_like_received:      'community',
};

// ── Tier thresholds (ordered descending for getTier lookup) ─────────────────
const TIERS = [
  { name: 'ambassador',   threshold: 750 },
  { name: 'connoisseur',  threshold: 300 },
  { name: 'enthusiast',   threshold: 100 },
  { name: 'contributor',  threshold:  25 },
  { name: 'newcomer',     threshold:   0 },
];

// ── Plan rewards per tier (one-time) ────────────────────────────────────────
const TIER_REWARDS = {
  contributor: { plan: 'supporter', durationDays: 30 },
  connoisseur: { plan: 'patron',   durationDays: 30 },
};

const PLAN_RANK = { free: 0, supporter: 1, patron: 2 };

/** Return the tier name for a given total score. */
function getTier(totalScore) {
  for (const t of TIERS) {
    if (totalScore >= t.threshold) return t.name;
  }
  return 'newcomer';
}

/**
 * Return the specialty category (highest-scoring category).
 * Returns 'allrounder' if no single category has >40% of total,
 * or null if totalScore is 0.
 */
function getSpecialty(categories) {
  const { curator = 0, photographer = 0, critic = 0, community = 0 } = categories || {};
  const total = curator + photographer + critic + community;
  if (total === 0) return null;

  const entries = [
    ['curator', curator],
    ['photographer', photographer],
    ['critic', critic],
    ['community', community],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  if (top[1] / total <= 0.4) return 'allrounder';
  return top[0];
}

/**
 * Atomically increment a user's contribution score and recompute tier/specialty.
 * Grants one-time plan rewards on tier-up. Fire-and-forget safe.
 */
async function incrementCred(userId, eventType) {
  const points = POINT_VALUES[eventType];
  const category = CATEGORY_MAP[eventType];
  if (!points || !category) return;

  const inc = {
    'contribution.totalScore': points,
    [`contribution.categories.${category}`]: points,
  };

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: inc },
    { new: true, select: 'contribution plan planExpiresAt' }
  );
  if (!user) return;

  const newTier = getTier(user.contribution.totalScore);
  const newSpecialty = getSpecialty(user.contribution.categories);

  const updates = {};
  if (newTier !== user.contribution.tier) updates['contribution.tier'] = newTier;
  if (newSpecialty !== user.contribution.specialty) updates['contribution.specialty'] = newSpecialty;

  // Check for all unclaimed tier rewards (handles tier-jumping, e.g. 0 → 100 skips contributor)
  const granted = user.contribution.rewardsGranted || [];
  const rewardTiers = Object.keys(TIER_REWARDS);
  for (const rewardTier of rewardTiers) {
    if (granted.includes(rewardTier)) continue;
    const tierThreshold = TIERS.find(t => t.name === rewardTier)?.threshold || Infinity;
    if (user.contribution.totalScore < tierThreshold) continue;

    const reward = TIER_REWARDS[rewardTier];
    const currentRank = PLAN_RANK[updates.plan || user.plan] || 0;
    const rewardRank = PLAN_RANK[reward.plan] || 0;
    const planExpired = user.planExpiresAt && new Date(user.planExpiresAt) < new Date();

    if (rewardRank > currentRank || planExpired) {
      updates.plan = reward.plan;
      updates.planStartedAt = new Date();
      updates.planExpiresAt = new Date(Date.now() + reward.durationDays * 24 * 60 * 60 * 1000);
    }
    if (!updates.$addToSet) updates.$addToSet = { 'contribution.rewardsGranted': { $each: [] } };
    updates.$addToSet['contribution.rewardsGranted'].$each.push(rewardTier);
  }

  if (Object.keys(updates).length > 0) {
    const { $addToSet, ...setFields } = updates;
    const updateOp = {};
    if (Object.keys(setFields).length > 0) updateOp.$set = setFields;
    if ($addToSet) updateOp.$addToSet = $addToSet;
    await User.updateOne({ _id: userId }, updateOp);
  }
}

module.exports = { POINT_VALUES, CATEGORY_MAP, TIERS, getTier, getSpecialty, incrementCred };
