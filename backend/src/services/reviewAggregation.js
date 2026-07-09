const Review = require('../models/Review');
const WineDefinition = require('../models/WineDefinition');

/**
 * Aggregation pipeline that produces one row per DISTINCT AUTHOR, carrying
 * that author's latest public review rating: `{ _id: <authorId>, rating }`.
 *
 * Forgery resistance (SECURITY_AUDIT_2026-07-08 M-3): the Review model
 * deliberately allows multiple reviews per author per wine (re-tastings are a
 * product feature), so the aggregate must not weight authors by how many
 * reviews they posted. Sorting by createdAt desc before grouping by author
 * makes $first pick each author's most recent review, so N reviews by one
 * account count exactly once — and the latest opinion wins.
 */
function buildLatestPerAuthorPipeline(wineDefinitionId) {
  return [
    { $match: { wineDefinition: wineDefinitionId, visibility: { $ne: 'private' } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$author', rating: { $first: '$normalizedRating' } } }
  ];
}

/**
 * Reduce the per-author rows to `{ avg, count }` where `count` is the
 * distinct-author count and `avg` the mean of each author's latest rating.
 * Returns `{ avg: null, count: 0 }` when there are no public reviews.
 */
function summarizeAuthorRatings(rows) {
  const ratings = (rows || [])
    .map((row) => row.rating)
    .filter((r) => typeof r === 'number' && Number.isFinite(r));
  if (ratings.length === 0) return { avg: null, count: 0 };
  const avg = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
  return { avg, count: ratings.length };
}

/**
 * Recalculate and update the community rating for a wine definition.
 * Called fire-and-forget after review create/update/delete/visibility change.
 *
 * Semantics: `communityRating.averageNormalized` is the average of each
 * distinct author's LATEST public review; `communityRating.reviewCount` is
 * the number of distinct authors (not the raw review count). Wines with no
 * public reviews are reset to `{ averageNormalized: null, reviewCount: 0 }`.
 */
async function updateWineCommunityRating(wineDefinitionId) {
  try {
    const rows = await Review.aggregate(buildLatestPerAuthorPipeline(wineDefinitionId));
    const { avg, count } = summarizeAuthorRatings(rows);
    await WineDefinition.updateOne(
      { _id: wineDefinitionId },
      { $set: { 'communityRating.averageNormalized': avg, 'communityRating.reviewCount': count } }
    );
  } catch (err) {
    console.error('Failed to update community rating for wine', wineDefinitionId, err.message);
  }
}

module.exports = { updateWineCommunityRating, buildLatestPerAuthorPipeline, summarizeAuthorRatings };
