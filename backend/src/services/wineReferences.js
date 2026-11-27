/**
 * What members have attached to a registry wine besides bottles: the things a
 * wine must not be deleted from under.
 *
 * A wine can be held by no bottle and still be in use: a wishlist item (an
 * import to the wishlist creates the wine and no bottle), a review, a journal
 * pairing, a wine-list entry, a recommendation, a member's own data entry on
 * the wine, a value suggested for it, a correction waiting on it, a curator's
 * question to its owners, a forum thread about it. services/registryGc asks
 * this before it removes a wine nothing seems to need; the admin delete
 * (routes/admin/wines.js) refuses on the same references and names them.
 */
const mongoose = require('mongoose');

// model name → the filter that finds a reference to the wine
const REFERENCES = [
  ['WishlistItem', (id) => ({ wineDefinition: id })],
  ['Review', (id) => ({ wineDefinition: id })],
  ['JournalEntry', (id) => ({ 'pairings.wine': id })],
  ['WineList', (id) => ({ $or: [{ 'sections.entries.wine': id }, { 'autoGroupEntries.wine': id }] })],
  ['Recommendation', (id) => ({ wine: id })],
  ['PersonalDataEntry', (id) => ({ wineDefinition: id })],
  ['RegistryDataValue', (id) => ({ wineDefinition: id })],
  ['WineCorrectionProposal', (id) => ({ wineDefinition: id, status: 'pending' })],
  ['WineOwnerInquiry', (id) => ({ wineDefinition: id, status: { $in: ['open', 'answered'] } })],
  ['Discussion', (id) => ({ wineDefinition: id })],
  ['DiscussionReply', (id) => ({ wineDefinition: id })],
];

/**
 * The first kind of member content that points at this wine, as a model name
 * ('WishlistItem', 'Review', …), or null when nothing does. Bottles and
 * bottles in "Recently deleted" are the caller's own check. Called by
 * services/registryGc.gcOrphanMintedWine. Throws on a database error: a
 * caller about to delete must treat "could not tell" as "in use".
 *
 * @param {string|import('mongoose').Types.ObjectId} wineId
 * @returns {Promise<string|null>}
 */
async function firstMemberReference(wineId) {
  const id = new mongoose.Types.ObjectId(String(wineId));
  for (const [modelName, filterFor] of REFERENCES) {
    // Lazy: this is every model that references a wine.
    const Model = require(`../models/${modelName}`);
    if (await Model.exists(filterFor(id))) return modelName;
  }
  return null;
}

module.exports = { firstMemberReference, REFERENCES };
