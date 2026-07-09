/**
 * Cellar Cred — contribution score and badge system.
 *
 * Users earn points for approved contributions (wine requests, images,
 * reviews, forum activity). Points accumulate into tiers that display
 * badges on profiles and posts.
 *
 * Cellar Cred does NOT change a user's subscription plan. Every feature is
 * free for all tiers, so contribution no longer grants supporter/patron — the
 * tiers below are purely cosmetic badges. Plans are set only via Stripe
 * (routes/stripe.js) or an admin grant (routes/admin/users.js).
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

// Plan ranking — retained because routes/stripe.js imports it to compare an
// incoming Stripe plan against the user's current grant. Cellar Cred itself no
// longer grants plans (see module header).
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
 * Atomically adjust a user's contribution score by a signed multiple of an
 * event's point value, clamped at 0, and recompute the tier/specialty badge.
 * Does not touch the subscription plan. Fire-and-forget safe.
 *
 * Cred accounting is SYMMETRIC (security audit L-19): every award has a
 * matching reversal (unlike/un-react toggles, content deletion, visibility
 * flips), so toggle loops and create/delete cycles net to zero instead of
 * inflating the publicly-displayed badge. The aggregation-pipeline update
 * clamps both counters at 0 atomically, so reversing an award that predates
 * this accounting (or a double reversal race) can never drive a score negative.
 */
async function adjustCred(userId, eventType, count) {
  const points = POINT_VALUES[eventType];
  const category = CATEGORY_MAP[eventType];
  if (!points || !category || !count) return;

  const delta = points * count;
  const catPath = `contribution.categories.${category}`;

  const user = await User.findByIdAndUpdate(
    userId,
    [{
      $set: {
        'contribution.totalScore': {
          $max: [0, { $add: [{ $ifNull: ['$contribution.totalScore', 0] }, delta] }],
        },
        [catPath]: {
          $max: [0, { $add: [{ $ifNull: [`$${catPath}`, 0] }, delta] }],
        },
      },
    }],
    { new: true, select: 'contribution' }
  );
  if (!user) return;

  const newTier = getTier(user.contribution.totalScore);
  const newSpecialty = getSpecialty(user.contribution.categories);

  // Recompute the cosmetic badge fields only. Cellar Cred no longer grants
  // plan upgrades — crossing a tier changes the badge, not the subscription.
  const updates = {};
  if (newTier !== user.contribution.tier) updates['contribution.tier'] = newTier;
  if (newSpecialty !== user.contribution.specialty) updates['contribution.specialty'] = newSpecialty;

  if (Object.keys(updates).length > 0) {
    await User.updateOne({ _id: userId }, { $set: updates });
  }
}

/** Award one event's points (tier/specialty recomputed, plan untouched). */
function incrementCred(userId, eventType) {
  return adjustCred(userId, eventType, 1);
}

/**
 * Reverse `count` prior awards of an event (default 1). Used when the action
 * that earned the points is undone: unlike/un-react, content deletion, or a
 * public review going private. Clamped at 0 — never goes negative.
 */
function decrementCred(userId, eventType, count = 1) {
  return adjustCred(userId, eventType, -Math.abs(count));
}

module.exports = { POINT_VALUES, CATEGORY_MAP, TIERS, PLAN_RANK, getTier, getSpecialty, incrementCred, decrementCred };
