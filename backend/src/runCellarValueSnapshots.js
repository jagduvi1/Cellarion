/**
 * Manually run the cellar value snapshot job (cost basis + replacement value).
 * Normally weekly via the scheduler; run on demand to seed/verify a data point.
 *
 * Run via:
 *   docker exec cellarion-backend node src/runCellarValueSnapshots.js
 */
'use strict';

const mongoose = require('mongoose');
const { runCellarValueSnapshots } = require('./services/cellarValueSnapshotJob');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

async function main() {
  await mongoose.connect(MONGO_URI);
  await runCellarValueSnapshots();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[runCellarValueSnapshots] Failed:', err);
  process.exit(1);
});
