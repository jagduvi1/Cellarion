/**
 * Barcode → wine: which registry wine a retail barcode belongs to, learned
 * from the bottles members added after scanning it.
 *
 * There is no barcode table to keep in sync and no record of who scanned what:
 * the evidence is the `barcode` field on members' own bottles, which leaves
 * with a bottle and with an account. For a code, bottles are grouped by wine
 * and counted by DISTINCT OWNERS — one member adding twelve bottles is one
 * vote, so a single mistake cannot outvote everyone else — and the most
 * confirmed wine the viewer is allowed to see wins. The answer names the wine
 * and how many members confirmed it, never who.
 *
 * Vintage: a GTIN usually stays the same across vintages, so the year is
 * suggested only when at least two owners agree on one vintage and nobody has
 * another — then the code really is vintage-specific.
 */

const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { canSeeWine } = require('./wineVisibility');
const { decorateGrapes } = require('../utils/grapeDisplay');

// Curation internals a member's screens never need (mirrors GET /api/wines/:id
// for non-curators).
const MEMBER_SELECT = '-scanImage -scanImageBack -scanFieldConflicts -normalizedKey -canonicalKey -verifiedChecks -identityProvenance -productNumber -previousSlugs -canary';

const CANDIDATES = 5;
const MIN_OWNERS_FOR_VINTAGE = 2;

/**
 * @param {string} code    canonical barcode (utils/barcode.normalizeBarcode)
 * @param {{ userId, roles }} viewer
 * @returns {Promise<{ wine: object|null, vintage?: string|null, owners?: number }>}
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

  for (const row of rows) {
    const wine = await WineDefinition.findById(row._id).select(MEMBER_SELECT).populate(['country', 'region', 'grapes']);
    // A pending or private draft wine of someone else is skipped, not
    // revealed: the next candidate (or nothing) answers instead.
    if (!wine || !canSeeWine(wine, viewer)) continue;
    const payload = decorateGrapes(wine);
    delete payload.createdBy;

    const vintagesSeen = new Set(row.vintages.flat().filter(Boolean));
    const vintage = row.owners >= MIN_OWNERS_FOR_VINTAGE && vintagesSeen.size === 1 ? [...vintagesSeen][0] : null;
    return { wine: payload, vintage, owners: row.owners };
  }
  return { wine: null };
}

module.exports = { lookupBarcode };
