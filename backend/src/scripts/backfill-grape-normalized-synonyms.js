/**
 * backfill-grape-normalized-synonyms.js
 *
 * One-off: computes Grape.normalizedSynonyms from Grape.synonyms for documents
 * that predate the field (the pre-save hook maintains it going forward, but
 * only fires on .save()). Idempotent — safe to re-run.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/backfill-grape-normalized-synonyms.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Grape = require('../models/Grape');
const { normalizeString } = require('../utils/normalize');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

async function run() {
  await mongoose.connect(MONGO_URI);
  const grapes = await Grape.find({ synonyms: { $exists: true, $ne: [] } })
    .select('name synonyms normalizedSynonyms').lean();

  let updated = 0;
  for (const g of grapes) {
    const normalized = (g.synonyms || []).map(s => normalizeString(s)).filter(Boolean);
    const current = g.normalizedSynonyms || [];
    if (normalized.length === current.length && normalized.every((v, i) => v === current[i])) continue;
    await Grape.updateOne({ _id: g._id }, { $set: { normalizedSynonyms: normalized } });
    updated++;
  }
  console.log(`Grapes with synonyms: ${grapes.length}, backfilled: ${updated}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('Backfill failed:', err); process.exit(1); });
