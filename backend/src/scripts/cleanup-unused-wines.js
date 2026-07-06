/**
 * cleanup-unused-wines.js
 *
 * Deletes all WineDefinition records that nothing references anymore, then
 * removes orphaned taxonomy entries (Grapes, Regions, Appellations).
 * Bottles and user data are never touched.
 *
 * "Unused" means no reference from ANY of: Bottle, WishlistItem, WineList
 * entries (sections + auto), Discussion, RestockAlert, JournalEntry,
 * Recommendation, Review, BottleImage, PriceTrackingRequest. A wine on a
 * wishlist is by definition not owned as a bottle — checking bottles alone
 * would delete exactly those wines and orphan the wishlist entries.
 *
 * For genuinely unused wines, also cascades:
 *   - WineVintageProfile / WineVintagePrice records
 *   - WineEmbedding rows (vector search)
 *   - CommunityWinePrice rows
 *   - WineNotDuplicate pairs involving the wine
 *   - Meilisearch index entries
 *
 * DRY-RUN BY DEFAULT — prints what would be deleted. Pass --apply to delete.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/cleanup-unused-wines.js
 *   docker exec cellarion-backend node src/scripts/cleanup-unused-wines.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineVintagePrice = require('../models/WineVintagePrice');
const WineEmbedding = require('../models/WineEmbedding');
const CommunityWinePrice = require('../models/CommunityWinePrice');
const WineNotDuplicate = require('../models/WineNotDuplicate');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const Bottle = require('../models/Bottle');
const WishlistItem = require('../models/WishlistItem');
const WineList = require('../models/WineList');
const Discussion = require('../models/Discussion');
const RestockAlert = require('../models/RestockAlert');
const JournalEntry = require('../models/JournalEntry');
const Recommendation = require('../models/Recommendation');
const Review = require('../models/Review');
const BottleImage = require('../models/BottleImage');
const Grape = require('../models/Grape');
const Region = require('../models/Region');
const Appellation = require('../models/Appellation');
// Register remaining schemas so Mongoose doesn't complain about unknown refs
require('../models/Country');
const searchService = require('../services/search');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const APPLY = process.argv.includes('--apply');

/** All (model, path) pairs that hold a live reference to a WineDefinition. */
const WINE_REF_SOURCES = [
  [Bottle, 'wineDefinition'],
  [WishlistItem, 'wineDefinition'],
  [WineList, 'sections.entries.wine'],
  [WineList, 'autoGroupEntries.wine'],
  [Discussion, 'wineDefinition'],
  [RestockAlert, 'wine'],
  [JournalEntry, 'wine'],
  [Recommendation, 'wine'],
  [Review, 'wineDefinition'],
  [BottleImage, 'wineDefinition'],
  [PriceTrackingRequest, 'wineDefinition'],
];

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY-RUN (pass --apply to delete)'}\n`);

  // ── Phase 1: Unused wine definitions ──────────────────────────────────────

  const allWineIds = await WineDefinition.distinct('_id');
  console.log(`Wine definitions total:  ${allWineIds.length}`);

  const usedSet = new Set();
  for (const [Model, path] of WINE_REF_SOURCES) {
    const ids = await Model.distinct(path);
    for (const id of ids) {
      if (id) usedSet.add(id.toString());
    }
  }
  const unusedIds = allWineIds.filter(id => !usedSet.has(id.toString()));
  console.log(`Referenced anywhere:     ${usedSet.size}`);
  console.log(`Unreferenced wines:      ${unusedIds.length}`);

  if (unusedIds.length > 0 && APPLY) {
    const cascade = [
      [WineVintageProfile, { wineDefinition: { $in: unusedIds } }, 'vintage profiles'],
      [WineVintagePrice, { wineDefinition: { $in: unusedIds } }, 'vintage prices'],
      [WineEmbedding, { wineDefinition: { $in: unusedIds } }, 'embeddings'],
      [CommunityWinePrice, { wineDefinition: { $in: unusedIds } }, 'community prices'],
      [WineNotDuplicate, { $or: [{ wineA: { $in: unusedIds } }, { wineB: { $in: unusedIds } }] }, 'not-duplicate pairs'],
    ];
    for (const [Model, filter, label] of cascade) {
      const r = await Model.deleteMany(filter);
      console.log(`Deleted ${label}: ${r.deletedCount}`);
    }

    const wineResult = await WineDefinition.deleteMany({ _id: { $in: unusedIds } });
    console.log(`Deleted wine definitions: ${wineResult.deletedCount}`);

    await searchService.initialize();
    if (searchService.getIsAvailable?.() === false) {
      console.warn('Meilisearch unavailable — deleted wines remain in the index until it is rebuilt.');
    } else {
      for (const id of unusedIds) {
        await searchService.removeWine(id);
      }
      console.log('Removed deleted wines from Meilisearch index.');
    }
  } else if (unusedIds.length > 0) {
    console.log('[dry-run] Would delete these wines and their profile/price/embedding/community-price rows.');
  } else {
    console.log('No unused wine definitions — skipping wine cleanup.');
  }

  // ── Phase 2: Orphaned taxonomy ────────────────────────────────────────────
  console.log('');

  // Grapes — referenced by WineDefinition.grapes and Region typical/permitted lists
  const usedGrapeIds = new Set([
    ...(await WineDefinition.distinct('grapes')).map(id => id.toString()),
    ...(await Region.distinct('typicalGrapes')).map(id => id.toString()),
    ...(await Region.distinct('permittedGrapes')).map(id => id.toString()),
  ]);
  const allGrapes = await Grape.distinct('_id');
  const unusedGrapeIds = allGrapes.filter(id => !usedGrapeIds.has(id.toString()));
  console.log(`Grapes total:            ${allGrapes.length}  unused: ${unusedGrapeIds.length}`);
  if (unusedGrapeIds.length > 0 && APPLY) {
    const r = await Grape.deleteMany({ _id: { $in: unusedGrapeIds } });
    console.log(`Deleted grapes:          ${r.deletedCount}`);
  }

  // Regions — referenced by WineDefinition.region and as parentRegion of other regions
  const usedRegionIds = new Set([
    ...(await WineDefinition.distinct('region')).filter(Boolean).map(id => id.toString()),
    ...(await Region.distinct('parentRegion')).filter(Boolean).map(id => id.toString()),
  ]);
  const allRegions = await Region.distinct('_id');
  const unusedRegionIds = allRegions.filter(id => !usedRegionIds.has(id.toString()));
  console.log(`Regions total:           ${allRegions.length}  unused: ${unusedRegionIds.length}`);
  if (unusedRegionIds.length > 0 && APPLY) {
    const r = await Region.deleteMany({ _id: { $in: unusedRegionIds } });
    console.log(`Deleted regions:         ${r.deletedCount}`);
  }

  // Appellations — plain string in WineDefinition.appellation; matched by
  // lowercased name against the Appellation collection's name field.
  const usedAppellationNames = new Set(
    (await WineDefinition.distinct('appellation'))
      .filter(Boolean)
      .map(s => s.toLowerCase())
  );
  const allAppellations = await Appellation.find({}, '_id name').lean();
  const unusedAppellationIds = allAppellations
    .filter(a => !usedAppellationNames.has(a.name.toLowerCase()))
    .map(a => a._id);
  console.log(`Appellations total:      ${allAppellations.length}  unused: ${unusedAppellationIds.length}`);
  if (unusedAppellationIds.length > 0 && APPLY) {
    const r = await Appellation.deleteMany({ _id: { $in: unusedAppellationIds } });
    console.log(`Deleted appellations:    ${r.deletedCount}`);
  }

  console.log(APPLY ? '\nDone.' : '\nDry-run complete — nothing deleted. Re-run with --apply to delete.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
