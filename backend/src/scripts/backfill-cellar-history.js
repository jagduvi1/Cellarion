/**
 * backfill-cellar-history.js
 *
 * One-off backfill for the "move bottles between cellars" feature: seed
 * Bottle.cellarHistory (and addedToCellarAt) for bottles that predate the field.
 *
 * Each such bottle gets a single journey entry for its current cellar, dated at
 * its added date (we can't reconstruct past moves), so the per-bottle history
 * timeline reads "Added to <cellar> on <date>" instead of being empty. The move
 * endpoint also backfills the origin entry on first move, so this migration is a
 * convenience, not a correctness requirement.
 *
 * Behaviour:
 *   - DRY-RUN by default; pass --apply to write.
 *   - Idempotent: only touches bottles whose cellarHistory is missing/empty.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/backfill-cellar-history.js          # dry run
 *   docker exec cellarion-backend node src/scripts/backfill-cellar-history.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const APPLY = new Set(process.argv.slice(2)).has('--apply');

const FILTER = { $or: [{ cellarHistory: { $exists: false } }, { cellarHistory: { $size: 0 } }] };

async function flush(ops) {
  if (!ops.length || !APPLY) return 0;
  const r = await Bottle.bulkWrite(ops, { ordered: false });
  return r.modifiedCount || 0;
}

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');
  console.log(APPLY ? 'Mode: APPLY (cellarHistory will be written)' : 'Mode: DRY RUN (no changes)');

  const total = await Bottle.countDocuments(FILTER);
  console.log(`Bottles needing a cellarHistory seed: ${total}`);
  if (total === 0) { console.log('\nNothing to do.'); await mongoose.disconnect(); return; }

  // cellarId -> name (include soft-deleted so the journey keeps a real name).
  const cellars = await Cellar.find({}, 'name').lean();
  const nameById = new Map(cellars.map((c) => [c._id.toString(), c.name]));

  let processed = 0, updated = 0, ops = [];
  const cursor = Bottle.find(FILTER).select('_id cellar createdAt addedToCellarAt').lean().cursor();
  for (let b = await cursor.next(); b != null; b = await cursor.next()) {
    processed++;
    const enteredAt = b.addedToCellarAt || b.createdAt || new Date();
    const cellarName = nameById.get(b.cellar?.toString()) || '';
    ops.push({
      updateOne: {
        filter: { _id: b._id },
        update: { $set: { addedToCellarAt: enteredAt, cellarHistory: [{ cellar: b.cellar, cellarName, enteredAt }] } },
      },
    });
    if (ops.length >= 500) { updated += await flush(ops); ops = []; }
    if (processed % 2000 === 0) console.log(`  …scanned ${processed}/${total}`);
  }
  updated += await flush(ops);

  console.log(`\nScanned:                 ${processed}`);
  console.log(`${APPLY ? 'Updated' : 'Would update'}:  ${APPLY ? updated : processed}`);
  if (!APPLY) console.log('\n(dry run — pass --apply to write)');
  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
