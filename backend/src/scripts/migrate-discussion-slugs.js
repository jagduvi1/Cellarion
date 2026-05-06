/**
 * Backfill `slug` on Discussion documents that don't have one yet.
 *
 * Idempotent — safe to run twice. Each slug is `slugify(title) + '-' + last6(_id)`
 * which makes collisions effectively impossible (the ObjectId suffix is the
 * collision-resistance mechanism, not a numeric "-2" retry loop).
 *
 * Run inside the backend container:
 *   docker exec cellarion-backend node src/scripts/migrate-discussion-slugs.js
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Discussion = require('../models/Discussion');
const { slugify } = require('../utils/normalize');

(async () => {
  await connectDB();

  // Ensure the new sparse-unique slug index exists before we start writing.
  await Discussion.syncIndexes();

  const total = await Discussion.countDocuments({});
  const missing = await Discussion.countDocuments({ slug: { $exists: false } });
  console.log(`[migrate-discussion-slugs] ${total} total discussions, ${missing} need a slug`);

  if (missing === 0) {
    console.log('[migrate-discussion-slugs] nothing to do');
    await mongoose.disconnect();
    return;
  }

  const cursor = Discussion.find({ slug: { $exists: false } })
    .select('_id title')
    .cursor();

  const ops = [];
  let updated = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const base = slugify(doc.title);
    const suffix = doc._id.toString().slice(-6);
    const slug = base ? `${base}-${suffix}` : suffix;

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { slug } }
      }
    });
    updated++;

    if (ops.length >= 500) {
      await Discussion.bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    await Discussion.bulkWrite(ops, { ordered: false });
  }

  console.log(`[migrate-discussion-slugs] updated ${updated} docs`);
  await mongoose.disconnect();
})().catch(err => {
  console.error('[migrate-discussion-slugs] FAILED:', err);
  process.exit(1);
});
