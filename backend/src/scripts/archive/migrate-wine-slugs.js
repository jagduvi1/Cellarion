/**
 * Backfill `slug` on all WineDefinition documents that don't have one yet.
 *
 * Idempotent — running it twice is safe (it skips docs that already have a slug).
 * Run inside the backend container:
 *   docker exec cellarion-backend node src/scripts/migrate-wine-slugs.js
 *
 * Logs collisions so you can audit ugly fallbacks (`-2`, `-3`) before the next deploy.
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const WineDefinition = require('../models/WineDefinition');
const { generateWineSlug } = require('../utils/normalize');

(async () => {
  await connectDB();

  // Ensure the new sparse-unique slug index exists in Mongo before we start writing.
  // Without this, the bulk update can briefly allow duplicate slugs.
  await WineDefinition.syncIndexes();

  const total = await WineDefinition.countDocuments({});
  const missing = await WineDefinition.countDocuments({ slug: { $exists: false } });
  console.log(`[migrate-wine-slugs] ${total} total wines, ${missing} need a slug`);

  if (missing === 0) {
    console.log('[migrate-wine-slugs] nothing to do');
    await mongoose.disconnect();
    return;
  }

  // In-memory set of slugs we've claimed in this run, plus existing slugs from DB.
  // Prevents duplicate slug assignment across the batch without 5000 round-trips.
  const taken = new Set(
    (await WineDefinition.find({ slug: { $exists: true, $ne: null } })
      .select('slug')
      .lean()).map(d => d.slug)
  );

  const cursor = WineDefinition.find({ slug: { $exists: false } })
    .select('_id name producer')
    .cursor();

  const ops = [];
  const collisions = [];
  let updated = 0;
  let empty = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const base = generateWineSlug(doc.name, doc.producer);
    if (!base) {
      empty++;
      continue;
    }

    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix++;
    }
    if (candidate !== base) {
      collisions.push({ id: doc._id.toString(), name: doc.name, producer: doc.producer, slug: candidate });
    }
    taken.add(candidate);

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { slug: candidate } }
      }
    });
    updated++;

    if (ops.length >= 500) {
      await WineDefinition.bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    await WineDefinition.bulkWrite(ops, { ordered: false });
  }

  console.log(`[migrate-wine-slugs] updated ${updated} docs`);
  if (empty > 0) {
    console.log(`[migrate-wine-slugs] WARNING: ${empty} docs had unsluggable name/producer — left unchanged`);
  }
  if (collisions.length > 0) {
    console.log(`[migrate-wine-slugs] ${collisions.length} slug collisions resolved with numeric suffix:`);
    for (const c of collisions.slice(0, 20)) {
      console.log(`  - ${c.slug}  (${c.producer} / ${c.name})  _id=${c.id}`);
    }
    if (collisions.length > 20) {
      console.log(`  …and ${collisions.length - 20} more (full list in DB by querying for slugs ending in -N)`);
    }
  }

  await mongoose.disconnect();
})().catch(err => {
  console.error('[migrate-wine-slugs] FAILED:', err);
  process.exit(1);
});
