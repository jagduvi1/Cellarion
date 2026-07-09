/**
 * recompute-community-ratings.js
 *
 * One-off recompute of WineDefinition.communityRating for every wine, using
 * the forgery-resistant author-dedup aggregation (SECURITY_AUDIT_2026-07-08
 * M-3): each distinct author contributes only their LATEST public review, and
 * reviewCount becomes the distinct-author count.
 *
 * Without this script, ratings inflated under the old per-review aggregation
 * self-correct only on each wine's next review event (create/update/delete/
 * visibility change). Run it once after deploying the fix to correct all
 * wines immediately.
 *
 * Behaviour:
 *   - DRY-RUN by default: prints what would change, changes nothing.
 *   - Pass --apply to actually write the recomputed ratings.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/recompute-community-ratings.js          # dry run
 *   docker exec cellarion-backend node src/scripts/recompute-community-ratings.js --apply
 *
 * Or locally (requires .env):
 *   cd backend && node src/scripts/recompute-community-ratings.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Review = require('../models/Review');
const WineDefinition = require('../models/WineDefinition');
const { buildLatestPerAuthorPipeline, summarizeAuthorRatings } = require('../services/reviewAggregation');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

function fmt(avg, count) {
  return `${avg == null ? 'null' : avg.toFixed(1)} / ${count}`;
}

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');
  console.log(APPLY ? 'Mode: APPLY (ratings will be written)' : 'Mode: DRY RUN (no changes)');
  console.log('');

  // Only wines that have (or had) a community rating footprint need a look:
  // wines with at least one review, plus wines with a stale non-zero count.
  const reviewedWineIds = await Review.distinct('wineDefinition');
  const staleWines = await WineDefinition.find(
    { 'communityRating.reviewCount': { $gt: 0 }, _id: { $nin: reviewedWineIds } },
    '_id'
  ).lean();
  const wineIds = [...reviewedWineIds, ...staleWines.map(w => w._id)];
  console.log(`Wines with reviews:                    ${reviewedWineIds.length}`);
  console.log(`Wines with stale non-zero counts:      ${staleWines.length}`);

  let changed = 0;
  let unchanged = 0;
  for (const wineId of wineIds) {
    const rows = await Review.aggregate(buildLatestPerAuthorPipeline(wineId));
    const { avg, count } = summarizeAuthorRatings(rows);

    const wine = await WineDefinition.findById(wineId, 'name producer communityRating').lean();
    if (!wine) continue;
    const oldAvg = wine.communityRating?.averageNormalized ?? null;
    const oldCount = wine.communityRating?.reviewCount ?? 0;

    if (oldAvg === avg && oldCount === count) {
      unchanged++;
      continue;
    }
    changed++;
    console.log(`  ${wine.producer || '?'} — ${wine.name || '?'}: ${fmt(oldAvg, oldCount)} → ${fmt(avg, count)}`);
    if (APPLY) {
      await WineDefinition.updateOne(
        { _id: wineId },
        { $set: { 'communityRating.averageNormalized': avg, 'communityRating.reviewCount': count } }
      );
    }
  }

  console.log('');
  console.log(`Unchanged: ${unchanged}`);
  console.log(`${APPLY ? 'Updated' : 'Would update'}: ${changed}`);
  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Recompute failed:', err);
  process.exit(1);
});
