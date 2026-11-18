/**
 * Barcode → wine: which registry wine a retail barcode belongs to.
 *
 * Two sources, in this order: the wine's own record of the code
 * (WineDefinition.barcodes, kept by services/barcodeRegistry.js from members'
 * bottles and catalogues), then the members' bottles themselves. On bottles,
 * evidence is grouped by wine and counted by DISTINCT OWNERS — one member
 * adding twelve bottles is one vote, so a single mistake cannot outvote
 * everyone else — and the most confirmed wine the viewer is allowed to see
 * wins. The answer names the wine and how many members confirmed it, never
 * who.
 *
 * Vintage: a GTIN usually stays the same across vintages, so the year is
 * suggested only when at least two owners agree on one vintage and nobody has
 * another — then the code really is vintage-specific.
 */

const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { canSeeWine } = require('./wineVisibility');
const { decorateGrapes } = require('../utils/grapeDisplay');
const { MEMBER_WINE_EXCLUDE_KEEP_CREATOR } = require('../config/constants');

// Curation internals a member's screens never need (the same select as
// GET /api/wines/:id for non-curators). createdBy stays loaded for canSeeWine
// and is deleted from the payload below.
const MEMBER_SELECT = MEMBER_WINE_EXCLUDE_KEEP_CREATOR;

const CANDIDATES = 5;
const MIN_OWNERS_FOR_VINTAGE = 2;

/**
 * The answer for one candidate wine, or null when the viewer may not see it
 * (a pending or private draft wine of someone else is skipped, not revealed).
 */
async function answerFor(wineId, row, viewer, entry) {
  const wine = await WineDefinition.findById(wineId).select(MEMBER_SELECT).populate(['country', 'region', 'grapes']);
  if (!wine || !canSeeWine(wine, viewer)) return null;
  const payload = decorateGrapes(wine);
  delete payload.createdBy;
  const owners = Math.max(row ? row.owners : 0, entry ? entry.owners || 0 : 0);
  const vintagesSeen = new Set(row ? row.vintages.flat().filter(Boolean) : []);
  const vintage = row && row.owners >= MIN_OWNERS_FOR_VINTAGE && vintagesSeen.size === 1 ? [...vintagesSeen][0] : null;
  return { wine: payload, vintage, owners, ...(entry && entry.bottleSize ? { bottleSize: entry.bottleSize } : {}) };
}

/**
 * The registry wine a barcode belongs to. The wine's own record of the code
 * (services/barcodeRegistry.js) answers first: it outlives the bottles that
 * taught it and holds catalogue codes no member has scanned. Without one,
 * members' bottles decide, most distinct owners first.
 * REST: GET /api/wines/barcode/:code.
 * @param {string} code    canonical barcode (utils/barcode.normalizeBarcode)
 * @param {{ userId, roles }} viewer
 * @returns {Promise<{ wine: object|null, vintage?: string|null, owners?: number, bottleSize?: string }>}
 */
async function lookupBarcode(code, viewer) {
  const rows = await Bottle.aggregate([
    { $match: { barcode: code } },
    // One row per (wine, owner): the vintages that owner has, and when.
    { $group: { _id: { wine: '$wineDefinition', user: '$user' }, vintages: { $addToSet: '$vintage' }, last: { $max: '$createdAt' } } },
    // One row per wine: how many owners, and every owner's vintages.
    { $group: { _id: '$_id.wine', owners: { $sum: 1 }, vintages: { $push: '$vintages' }, last: { $max: '$last' } } },
    { $sort: { owners: -1, last: -1 } },
    { $limit: CANDIDATES },
  ]);

  const holder = await WineDefinition.findOne({ 'barcodes.code': code }).select('+barcodes').lean();
  if (holder) {
    const entry = (holder.barcodes || []).find((b) => b.code === code);
    const row = rows.find((r) => String(r._id) === String(holder._id));
    const answer = await answerFor(holder._id, row, viewer, entry);
    if (answer) return answer;
  }
  for (const row of rows) {
    if (holder && String(row._id) === String(holder._id)) continue;
    const answer = await answerFor(row._id, row, viewer);
    if (answer) return answer;
  }
  return { wine: null };
}

module.exports = { lookupBarcode };
