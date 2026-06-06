/**
 * Bottle-size data maintenance — list distinct stored sizes, bulk-remap one
 * value to another, and normalize the whole collection to canonical codes.
 *
 * Used by the admin "Bottle Sizes" tab and by runNormalizeBottleSizes.js.
 */
const Bottle = require('../models/Bottle');
const { normalizeBottleSize, isCanonicalCode, DEFAULT_SIZE } = require('../config/bottleSizes');

/** Distinct bottleSize values in use, with counts + canonical flag + suggestion. */
async function distinctSizes() {
  const rows = await Bottle.aggregate([
    { $group: { _id: '$bottleSize', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  return rows.map((r) => ({
    value: r._id ?? null,
    count: r.count,
    canonical: isCanonicalCode(r._id),
    // What normalize-all / remap would turn this into (DEFAULT for empty,
    // null when it can't be parsed → needs a manual remap decision).
    suggested: r._id == null || r._id === '' ? DEFAULT_SIZE : normalizeBottleSize(r._id),
  }));
}

/** Normalize every bottle's size to its canonical code in bulk. Idempotent. */
async function normalizeAll() {
  const rows = await distinctSizes();
  let changed = 0;
  const unparseable = [];
  for (const r of rows) {
    const from = r.value;
    const to = from == null || from === '' ? DEFAULT_SIZE : normalizeBottleSize(from);
    if (to == null) {
      unparseable.push({ value: from, count: r.count }); // leave for manual remap
      continue;
    }
    if (to !== from) {
      const filter = from == null ? { bottleSize: null } : { bottleSize: from };
      const res = await Bottle.updateMany(filter, { $set: { bottleSize: to } });
      changed += res.modifiedCount || 0;
    }
  }
  return { changed, unparseable };
}

/** Bulk-remap one stored value to a canonical code (admin manual fix). */
async function remap(from, to) {
  if (typeof from !== 'string' || from === '') throw new Error('"from" value is required');
  const target = normalizeBottleSize(to);
  if (!target) throw new Error('"to" must be a valid size (e.g. 750ml or 1.5L)');
  const res = await Bottle.updateMany({ bottleSize: from }, { $set: { bottleSize: target } });
  return { from, to: target, modified: res.modifiedCount || 0 };
}

module.exports = { distinctSizes, normalizeAll, remap };
