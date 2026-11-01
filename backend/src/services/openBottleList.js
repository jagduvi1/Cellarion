// The open bottles of a set of cellars, most urgent first — the cellar page's
// "Open now" strip, so an open bottle is finished (and rated) before it turns
// instead of being forgotten behind its neighbours. Sent with the FIRST page
// of the bottle list (single cellar and "all my cellars"), whatever filters
// the list has: the strip is about what stands open, not what is searched.
const Bottle = require('../models/Bottle');
const { openBottleDeadline } = require('../utils/openBottleUtils');

// What the strip shows at most. Open bottles are few; the read cap only
// bounds a pathological cellar before the deadline sort.
const OPEN_NOW_MAX = 20;
const READ_CAP = 200;

/**
 * @param {Array} cellarIds cellars the caller may read (checked by the route)
 * @returns {Promise<Array>} lean bottles with the fields the strip renders
 */
async function listOpenBottles(cellarIds) {
  if (!Array.isArray(cellarIds) || cellarIds.length === 0) return [];
  const rows = await Bottle.find({ cellar: { $in: cellarIds }, status: 'active', openedAt: { $ne: null } })
    .select('cellar vintage bottleSize openedAt preservationMethod pours wineDefinition')
    .populate('wineDefinition', 'name producer type')
    .limit(READ_CAP)
    .lean();
  rows.sort((a, b) => openBottleDeadline(a) - openBottleDeadline(b));
  return rows.slice(0, OPEN_NOW_MAX);
}

module.exports = { listOpenBottles, OPEN_NOW_MAX };
