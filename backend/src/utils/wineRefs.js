/**
 * Every model that references a WineDefinition, and how a merge deals with it.
 *
 * A wine merge (reassignWineRefs in routes/admin/wines.js, also used when a
 * private draft is attached to a registry wine) must move or drop every
 * reference to the wine it then deletes, or rows are left pointing at nothing.
 * utils/wineRefs.test.js checks this list against the model files, and
 * routes/admin/wines.merge.test.js checks that reassignWineRefs touches each
 * handled model, so a new model with a wine reference fails a test until
 * someone decides what a merge does with it.
 *
 * scripts/cleanup-unused-wines reads the same list: there a listed model
 * keeps a wine in use unless the script deletes its rows with the wine.
 *
 * Names only, no model requires: safe to load from anywhere.
 */

/** Moved to the kept wine, or dropped, inside reassignWineRefs. */
const WINE_REF_HANDLED = [
  'Bottle', 'DeletedBottle', 'BottleImage', 'WineVintageProfile', 'WineVintagePrice', 'WineReport',
  'Discussion', 'DiscussionReply', 'Review', 'WishlistItem', 'PriceTrackingRequest', 'PriceTrackingSkip',
  'CommunityWinePrice', 'JournalEntry', 'Recommendation', 'RestockAlert', 'WineRequest', 'WineList',
  'WineNotDuplicate', 'WineEmbedding', 'PersonalDataEntry', 'RegistryDataValue',
];

/** Follow a merge outside reassignWineRefs: the merge routes call these after it. */
const WINE_REF_EXEMPT = {
  WineCorrectionProposal: 'pending proposals on or targeting the wine are closed by closePendingForWine',
  WineOwnerInquiry: 'active inquiries move to the kept wine in repointInquiriesForWineMerge',
};

module.exports = { WINE_REF_HANDLED, WINE_REF_EXEMPT };
