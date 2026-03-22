const Review = require('../models/Review');
const WineDefinition = require('../models/WineDefinition');

/**
 * Recalculate and update the community rating for a wine definition.
 * Called fire-and-forget after review create/update/delete.
 */
async function updateWineCommunityRating(wineDefinitionId) {
  try {
    const result = await Review.aggregate([
      { $match: { wineDefinition: wineDefinitionId, visibility: { $ne: 'private' } } },
      { $group: { _id: null, avg: { $avg: '$normalizedRating' }, count: { $sum: 1 } } }
    ]);
    const avg = result[0]?.avg ?? null;
    const count = result[0]?.count ?? 0;
    await WineDefinition.updateOne(
      { _id: wineDefinitionId },
      { $set: { 'communityRating.averageNormalized': avg, 'communityRating.reviewCount': count } }
    );
  } catch (err) {
    console.error('Failed to update community rating for wine', wineDefinitionId, err.message);
  }
}

module.exports = { updateWineCommunityRating };
