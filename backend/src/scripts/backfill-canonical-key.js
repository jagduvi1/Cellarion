/**
 * Backfill canonicalKey for every WineDefinition (dup analysis 2026-07-22,
 * phase 1). Safe to re-run: rows whose stored key already matches are skipped,
 * and the pre-validate hook keeps keys current for all save-based writes after
 * this one-time pass.
 *
 * Dry-run by default — prints what would change plus every collision set the
 * canonical grouping reveals (the admin merge queue). Pass --apply to write.
 *
 *   docker exec cellarion-backend node src/scripts/backfill-canonical-key.js
 *   docker exec cellarion-backend node src/scripts/backfill-canonical-key.js --apply
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { computeCanonicalKey } = require('../utils/wineIdentity');

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const wines = await WineDefinition.find({})
    .select('name producer appellation canonicalKey')
    .lean();

  const groups = new Map();
  const ops = [];
  let unchanged = 0;
  for (const w of wines) {
    const key = computeCanonicalKey(w.name, w.producer, w.appellation);
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    group.push(w);
    if (w.canonicalKey === key) { unchanged += 1; continue; }
    ops.push({ updateOne: { filter: { _id: w._id }, update: { $set: { canonicalKey: key } } } });
  }

  const collisions = [...groups.values()].filter(arr => arr.length >= 2);
  console.log(`[backfill-canonical-key] ${apply ? 'APPLY' : 'DRY-RUN'} wines=${wines.length} toSet=${ops.length} unchanged=${unchanged} collisionSets=${collisions.length}`);
  for (const set of collisions.slice(0, 50)) {
    console.log(`  collision: ${set.map(w => `"${w.name}" — ${w.producer} [${w._id}]`).join('  |  ')}`);
  }
  if (collisions.length > 50) console.log(`  … and ${collisions.length - 50} more sets`);

  if (apply && ops.length > 0) {
    const res = await WineDefinition.bulkWrite(ops, { ordered: false });
    console.log(`[backfill-canonical-key] modified=${res.modifiedCount}`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
