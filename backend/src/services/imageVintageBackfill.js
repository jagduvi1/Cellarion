/**
 * One-time backfill of BottleImage.vintage for rows that predate the field
 * (support ticket 2026-10-09). Runs at boot, after the DB connects: a photo
 * tied to a bottle takes that bottle's vintage; a wine-level upload or a
 * label scan (no bottle) gets an explicit null. Both end with the key
 * present, so the next boot finds nothing to do — the `$exists: false`
 * probe is the whole cost of a no-op run.
 *
 * Idempotent and crash-safe: every batch is its own bulkWrite, and a row is
 * only ever written once (it leaves the `$exists: false` set as soon as it
 * carries the key). Safe to run beside live traffic: the field is read with
 * `$in`/equality only, so a half-backfilled table merely falls back to the
 * wine-wide photo for the rows not yet done.
 */
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const { photoVintage } = require('../utils/imageVintage');

const BATCH = 500;

async function backfillImageVintages() {
  let done = 0;
  for (;;) {
    const rows = await BottleImage.find({ vintage: { $exists: false } })
      .select('_id bottle').limit(BATCH).lean();
    if (!rows.length) break;

    const bottleIds = [...new Set(rows.filter((r) => r.bottle).map((r) => String(r.bottle)))];
    const vintageOf = new Map();
    if (bottleIds.length) {
      const bottles = await Bottle.find({ _id: { $in: bottleIds } }).select('_id vintage').lean();
      for (const b of bottles) vintageOf.set(String(b._id), photoVintage(b.vintage));
    }
    const ops = rows.map((r) => ({
      updateOne: {
        filter: { _id: r._id, vintage: { $exists: false } },
        update: { $set: { vintage: r.bottle ? (vintageOf.get(String(r.bottle)) ?? null) : null } },
      },
    }));
    const res = await BottleImage.bulkWrite(ops, { ordered: false });
    const modified = res.modifiedCount ?? 0;
    done += modified;
    // Nothing matched means another process got there first — stop rather
    // than spin on the same page forever.
    if (modified === 0) break;
  }
  return done;
}

module.exports = { backfillImageVintages, BATCH };
