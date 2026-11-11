// The verdicts "these wines are NOT the same wine" (models/WineNotDuplicate):
// one row per unordered pair of wines, the smaller id first. An admin records
// them from a duplicate queue, and every duplicate scan leaves a pair with a
// verdict out, so a set that was judged once does not come back.
//
// Callers: the duplicate queues (routes/admin/wineDuplicates.js), the
// fragmentation scans (services/registryFragmentation.js), and the two places
// a wine goes away (routes/admin/wines.js on delete, services/wineMergeOps.js
// on merge).
const mongoose = require('mongoose');
const WineNotDuplicate = require('../models/WineNotDuplicate');

// A pair as the rows store it and the scans look it up: "smaller|larger".
const pairKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);

/**
 * Every pair with a verdict, loaded once for a scan. Returns `{ has(a, b) }`:
 * whether the two wine ids, in either order, were judged not duplicates.
 */
async function loadNotDuplicates() {
  const rows = await WineNotDuplicate.find({}).select('wineA wineB').lean();
  const keys = new Set(rows.map((d) => `${d.wineA}|${d.wineB}`));
  return { has: (a, b) => keys.has(pairKey(a, b)) };
}

/**
 * All unordered pairs of a set of wine ids, as `{ wineA, wineB }` ObjectIds
 * with wineA the smaller: the shape of a row.
 */
function buildWinePairs(ids) {
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      pairs.push({ wineA: new mongoose.Types.ObjectId(a), wineB: new mongoose.Types.ObjectId(b) });
    }
  }
  return pairs;
}

/**
 * Record the verdict for every pair of `ids` (an upsert: recording a pair
 * twice is harmless). Returns the number of pairs. Caller: POST
 * /api/admin/wines/dismiss-duplicates.
 */
async function markNotDuplicates(ids) {
  const pairs = buildWinePairs(ids);
  await WineNotDuplicate.bulkWrite(
    pairs.map(p => ({
      updateOne: {
        filter: { wineA: p.wineA, wineB: p.wineB },
        update: { $setOnInsert: { wineA: p.wineA, wineB: p.wineB } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
  return pairs.length;
}

/**
 * Withdraw the verdict for every pair of `ids`. Returns the number of rows
 * removed. Caller: DELETE /api/admin/wines/dismiss-duplicates.
 */
async function unmarkNotDuplicates(ids) {
  const result = await WineNotDuplicate.deleteMany({ $or: buildWinePairs(ids) });
  return result.deletedCount || 0;
}

/**
 * Drop every verdict that names a wine that is going away. Returns the query,
 * so the caller can run it beside its other clean-up.
 */
function forgetWine(wineId) {
  return WineNotDuplicate.deleteMany({ $or: [{ wineA: wineId }, { wineB: wineId }] });
}

module.exports = { loadNotDuplicates, buildWinePairs, markNotDuplicates, unmarkNotDuplicates, forgetWine };
