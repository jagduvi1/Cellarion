/**
 * One-off / on-demand backfill: normalize every bottle's size to a canonical
 * code ('750ml (Standard)' → '750ml', '1.5L (Magnum)' → '1500ml', …).
 * Idempotent. Also runnable from the admin Bottle Sizes tab.
 *
 * Run via:
 *   docker exec cellarion-backend node src/runNormalizeBottleSizes.js
 */
'use strict';

const mongoose = require('mongoose');
const { normalizeAll } = require('./services/bottleSizeMaintenance');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

async function main() {
  await mongoose.connect(MONGO_URI);
  const result = await normalizeAll();
  console.log(`[normalizeBottleSizes] ${result.changed} bottle(s) normalized.`);
  if (result.unparseable.length) {
    console.log('[normalizeBottleSizes] needs manual remap:', JSON.stringify(result.unparseable));
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[normalizeBottleSizes] Failed:', err);
  process.exit(1);
});
