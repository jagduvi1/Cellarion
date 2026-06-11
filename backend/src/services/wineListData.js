const Bottle = require('../models/Bottle');

/**
 * Load and populate bottles for a wine list, returning a Map<bottleId, bottle>.
 *
 * Scoped to the wine list's cellar: entry bottle IDs are client-supplied, so an
 * unscoped $in lookup would let a list render another tenant's bottles into a
 * (potentially public) PDF.
 */
async function loadBottleMap(wineList) {
  // Collect all bottle IDs from both modes
  const bottleIds = new Set();
  if (wineList.structureMode === 'custom') {
    for (const section of wineList.sections || []) {
      for (const entry of section.entries || []) {
        bottleIds.add(entry.bottle.toString());
      }
    }
  } else {
    for (const entry of wineList.autoGroupEntries || []) {
      bottleIds.add(entry.bottle.toString());
    }
  }

  const bottles = await Bottle.find({ _id: { $in: [...bottleIds] }, cellar: wineList.cellar })
    .populate({
      path: 'wineDefinition',
      populate: [
        { path: 'country', select: 'name' },
        { path: 'region', select: 'name' },
        { path: 'grapes', select: 'name' },
      ],
      select: 'name producer type appellation country region grapes classification'
    })
    .lean();

  const map = new Map();
  for (const b of bottles) {
    map.set(b._id.toString(), b);
  }
  return map;
}

module.exports = { loadBottleMap };
