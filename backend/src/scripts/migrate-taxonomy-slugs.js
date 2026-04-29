/**
 * Backfill `slug` on Country, Region, and Grape documents that don't have one yet.
 * Idempotent — running twice is safe (skips docs that already have a slug).
 *
 * docker exec cellarion-backend node src/scripts/migrate-taxonomy-slugs.js
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const { slugify } = require('../utils/normalize');

async function backfill(Model, label) {
  // syncIndexes is best-effort — pre-existing schema/index quirks shouldn't block
  // the slug backfill. The in-memory `taken` set below prevents duplicates anyway.
  try {
    await Model.syncIndexes();
  } catch (err) {
    console.warn(`[${label}] syncIndexes warning (non-fatal):`, err.message);
  }
  const missing = await Model.countDocuments({ slug: { $exists: false } });
  if (missing === 0) {
    console.log(`[${label}] already fully slugged`);
    return;
  }

  const taken = new Set(
    (await Model.find({ slug: { $exists: true, $ne: null } }).select('slug').lean())
      .map(d => d.slug)
  );

  const cursor = Model.find({ slug: { $exists: false } }).select('_id name').cursor();
  const ops = [];
  let updated = 0;
  const collisions = [];

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const base = slugify(doc.name);
    if (!base) continue;
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix++}`;
    }
    if (candidate !== base) collisions.push({ id: doc._id, name: doc.name, slug: candidate });
    taken.add(candidate);
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { slug: candidate } } } });
    updated++;
    if (ops.length >= 200) {
      await Model.bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }
  if (ops.length) await Model.bulkWrite(ops, { ordered: false });

  console.log(`[${label}] updated ${updated} docs`);
  if (collisions.length) {
    console.log(`[${label}] ${collisions.length} collision(s) with -N suffix:`);
    collisions.forEach(c => console.log(`  ${c.slug}  (${c.name})`));
  }
}

(async () => {
  await connectDB();
  await backfill(Country, 'countries');
  await backfill(Region, 'regions');
  await backfill(Grape, 'grapes');
  await mongoose.disconnect();
  console.log('Done.');
})().catch(err => { console.error('FAILED:', err); process.exit(1); });
