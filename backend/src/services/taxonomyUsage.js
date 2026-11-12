// How many registry wines use each taxonomy entry, and whether a user-minted
// entry still needs an admin's eye. Read by the admin taxonomy lists
// (routes/admin/taxonomy.js).
//
// The lists can merge and delete, and both need the same context to be used
// safely: how many wines actually reference this document. Delete refuses a
// document in use server-side; the count makes that visible BEFORE the click,
// and for a merge it tells the admin which of two spellings is the real one
// (merge the 1-wine typo into the 300-wine canonical, never the reverse).
const WineDefinition = require('../models/WineDefinition');
const { normalizeAppellation, normalizeAppellationKey } = require('../utils/normalize');

/**
 * Does this user-minted taxonomy entry need a human to look at it?
 *
 * Two separate facts, deliberately: `createdByUser` records that a user write
 * minted this document rather than a curator (services/findOrCreateWine), and
 * `reviewedAt` records whether a human has since looked. An origin is not a
 * task: flagging every minted entry makes "approve without looking" the only
 * sensible answer, which is the same as not reading it.
 *
 * So the lists ask a better question than "who made this?". A document already
 * carrying wines has been proven real by use, in a way an approval click adds
 * nothing to. What deserves a human is the one nobody uses: that is where junk
 * sits, and where a typo would.
 *
 * `createdByUser` is never cleared by anything. It stays as the record of where
 * the document came from. Approving stamps `reviewedAt` instead. Duplicates are
 * a separate question with their own scan (GET /regions/duplicate-candidates).
 *
 * Callers: the region, grape, classification and sweetness-term lists.
 *
 * @param {{createdByUser?: boolean, reviewedAt?: Date|null}} doc
 * @param {number} wineCount
 * @returns {boolean}
 */
function needsHumanReview(doc, wineCount) {
  return !!doc?.createdByUser && !doc?.reviewedAt && wineCount === 0;
}

/** Map<idString, wineCount> for a ref field ('country' | 'region'): the country and region lists. */
async function wineCountsByRef(field) {
  const rows = await WineDefinition.aggregate([
    // Quarantined rows don't count as "in use" — mirror taxonomyReview.js.
    { $match: { [field]: { $ne: null }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n]));
}

/** Map<grapeIdString, wineCount> (grapes is an array field): the grape list. */
async function wineCountsByGrape() {
  const rows = await WineDefinition.aggregate([
    { $match: { nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
    { $unwind: '$grapes' },
    { $group: { _id: '$grapes', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n]));
}

/** Map<classificationIdString, wineCount> (classifications is an array field): the classification list. */
async function wineCountsByClassification() {
  const rows = await WineDefinition.aggregate([
    { $match: { nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
    { $unwind: '$classifications' },
    { $group: { _id: '$classifications', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n]));
}

/**
 * Map<normalizedAppellation, wineCount>: the appellation list. Wines store the
 * appellation as free text (not a ref — see routes/admin/import.js), so the
 * join is by normalized string: the same normalization both writers apply.
 */
async function wineCountsByAppellation() {
  const rows = await WineDefinition.aggregate([
    { $match: { appellation: { $nin: [null, ''] }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
    { $group: { _id: '$appellation', n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) {
    const key = normalizeAppellationKey(normalizeAppellation(r._id || '') || r._id || '');
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + r.n);
  }
  return map;
}

/**
 * Map<sweetnessTermIdString, wineCount>: the sweetness-term list. A wine
 * counts for the term it carries as its label term and for the one it is
 * known by as its style (WineDefinition.sweetnessStyle).
 */
async function wineCountsBySweetnessTerm() {
  const [labels, styles] = await Promise.all([
    WineDefinition.aggregate([
      { $match: { labelSweetness: { $ne: null } } },
      { $group: { _id: '$labelSweetness', n: { $sum: 1 } } },
    ]),
    WineDefinition.aggregate([
      { $match: { 'sweetnessStyle.term': { $exists: true, $ne: null } } },
      { $group: { _id: '$sweetnessStyle.term', n: { $sum: 1 } } },
    ]),
  ]);
  const map = new Map();
  for (const r of [...labels, ...styles]) map.set(String(r._id), (map.get(String(r._id)) || 0) + r.n);
  return map;
}

module.exports = {
  needsHumanReview, wineCountsByRef, wineCountsByGrape, wineCountsByClassification,
  wineCountsByAppellation, wineCountsBySweetnessTerm,
};
