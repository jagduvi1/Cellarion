/**
 * backfill-image-wine-refs.js
 *
 * Bottle photos uploaded while their bottle still waited for a wine request
 * were stored without a wineDefinition, and nothing filled it in when the
 * request was resolved — so the by-wine photo lookups never showed them on
 * the owner's other bottles of the same wine (support ticket 2026-09-07:
 * one of two identical bottles had the photo, the other did not). The
 * resolve route stamps the wine now; this fills the rows created before.
 *
 * Sets BottleImage.wineDefinition from the photo's bottle where the row has
 * none and the bottle has a wine. Dry run by default.
 *
 * Usage (container running):
 *   docker exec cellarion-backend node src/scripts/backfill-image-wine-refs.js
 *   docker exec cellarion-backend node src/scripts/backfill-image-wine-refs.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const APPLY = process.argv.includes('--apply');

async function run() {
  await mongoose.connect(MONGO_URI);
  const rows = await BottleImage.find({ wineDefinition: null, bottle: { $ne: null } }).select('_id bottle').lean();
  const bottleIds = [...new Set(rows.map((r) => String(r.bottle)))];
  const bottles = await Bottle.find({ _id: { $in: bottleIds }, wineDefinition: { $ne: null } }).select('_id wineDefinition').lean();
  const wineOf = new Map(bottles.map((b) => [String(b._id), b.wineDefinition]));
  const fixable = rows.filter((r) => wineOf.has(String(r.bottle)));
  console.log(`photos without a wine: ${rows.length} | with a bottle that has one: ${fixable.length}${APPLY ? '' : ' (dry run — pass --apply to write)'}`);
  if (APPLY && fixable.length) {
    const ops = fixable.map((r) => ({ updateOne: { filter: { _id: r._id, wineDefinition: null }, update: { $set: { wineDefinition: wineOf.get(String(r.bottle)) } } } }));
    const res = await BottleImage.bulkWrite(ops, { ordered: false });
    console.log(`stamped: ${res.modifiedCount}`);
  }
  await mongoose.disconnect();
}

run().catch((e) => { console.error('backfill-image-wine-refs failed:', e.message); process.exit(1); });
