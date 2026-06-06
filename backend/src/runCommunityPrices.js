/**
 * Manually run the community release-price aggregation. Normally this runs
 * weekly via the scheduler; run it by hand after a bulk import, when seeding,
 * or to verify the feature.
 *
 * Run via:
 *   docker exec cellarion-backend node src/runCommunityPrices.js
 */
'use strict';

const mongoose = require('mongoose');
const { runCommunityPriceAggregation } = require('./services/communityPriceJob');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

async function main() {
  await mongoose.connect(MONGO_URI);
  const result = await runCommunityPriceAggregation();
  console.log('[runCommunityPrices] Done:', result);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[runCommunityPrices] Failed:', err);
  process.exit(1);
});
