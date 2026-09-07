/**
 * The "lot": every ACTIVE bottle of the same wine AND vintage in the user's
 * OWN cellars — the case journey's definition of a case (Cellarion has no
 * case entity). The drink window, and the price of a case bought as one
 * lot, are properties of the wine and vintage rather than of one bottle
 * (support ticket 2026-09-06: six identical updates for six bottles), so the
 * bottle edit form's "also apply to the other N", the bulk bar and
 * update_bottle's apply_to_lot all write to the lot found HERE — one
 * definition, one query.
 *
 * Owned cellars only: bottles in a cellar shared with the user belong to its
 * owner's decisions (the bulk bar is owner-only for the same reason). Bottle
 * size is deliberately NOT part of the key — a magnum ages differently, but
 * the request was wine + vintage, and the checkbox is opt-in per save.
 */
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { CONSUMED_STATUSES } = require('../config/constants');

// The fields a lot shares. Everything else — rating, notes, reservation,
// rack slot, purchase metadata — stays per bottle.
const LOT_FIELDS = ['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil', 'price', 'currency'];

async function lotSiblingQuery(userId, bottle) {
  const wineId = bottle?.wineDefinition && (bottle.wineDefinition._id || bottle.wineDefinition);
  if (!wineId) return null;
  const cellars = await Cellar.find({ user: userId, deletedAt: null }).select('_id').lean();
  if (!cellars.length) return null;
  // '' and null vintages read as NV in the grouped cellar view; match that set.
  const vintage = typeof bottle.vintage === 'string' && bottle.vintage.trim() ? bottle.vintage.trim() : 'NV';
  return {
    _id: { $ne: bottle._id },
    cellar: { $in: cellars.map((c) => c._id) },
    wineDefinition: wineId,
    vintage: vintage === 'NV' ? { $in: ['NV', '', null] } : vintage,
    status: { $nin: CONSUMED_STATUSES },
  };
}

/** Ids only — for the bottle page's "also apply to the other N" checkbox. */
async function findLotSiblingIds(userId, bottle) {
  const q = await lotSiblingQuery(userId, bottle);
  if (!q) return [];
  const rows = await Bottle.find(q).select('_id').lean();
  return rows.map((r) => String(r._id));
}

/** Full documents, oldest first — for a write path that saves each sibling. */
async function findLotSiblings(userId, bottle) {
  const q = await lotSiblingQuery(userId, bottle);
  if (!q) return [];
  return Bottle.find(q).sort({ createdAt: 1 });
}

/** The subset of an update payload that a lot shares (undefined = not sent). */
function pickLotFields(fields) {
  const out = {};
  for (const k of LOT_FIELDS) if (fields[k] !== undefined) out[k] = fields[k];
  return out;
}

module.exports = { LOT_FIELDS, findLotSiblingIds, findLotSiblings, pickLotFields };
