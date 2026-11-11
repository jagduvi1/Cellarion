// How many bottles members hold of each registry wine. The admin queues show
// the count beside a wine, so the admin sees how many cellars a merge, an edit
// or a delete of that wine reaches.
const Bottle = require('../models/Bottle');

/**
 * Bottle counts for a list of wines, in one aggregate. Returns
 * Map<wineIdString, count>; a wine nobody holds is absent from the map.
 * `wineIds` are ObjectIds (an aggregate does not cast strings).
 *
 * Callers: the duplicate queues (routes/admin/wineDuplicates.js), the
 * name-check queue (routes/admin/wineQualityQueues.js) and the low-confidence
 * queue (routes/admin/wines.js).
 */
async function bottleCountsByWine(wineIds) {
  const counts = new Map();
  if (wineIds.length === 0) return counts;
  const rows = await Bottle.aggregate([
    { $match: { wineDefinition: { $in: wineIds } } },
    { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
  ]);
  for (const row of rows) counts.set(String(row._id), row.count);
  return counts;
}

module.exports = { bottleCountsByWine };
