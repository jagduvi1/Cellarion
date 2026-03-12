/**
 * cleanup-unused-wines.js
 *
 * Deletes all WineDefinition records that have no bottles referencing them,
 * then removes orphaned taxonomy entries (Grapes, Regions, Appellations).
 * Bottles and user data are never touched.
 *
 * Also cleans up:
 *   - WineVintageProfile records for the deleted wines
 *   - Meilisearch index entries for the deleted wines
 *   - Grape documents not referenced by any remaining wine
 *   - Region documents not referenced by any remaining wine
 *   - Appellation documents whose name is not used by any remaining wine
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/cleanup-unused-wines.js
 *
 * Or locally (requires .env):
 *   cd backend && node src/scripts/cleanup-unused-wines.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const Bottle = require('../models/Bottle');
const Grape = require('../models/Grape');
const Region = require('../models/Region');
const Appellation = require('../models/Appellation');
// Register remaining schemas so Mongoose doesn't complain about unknown refs
require('../models/Country');
const searchService = require('../services/search');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');

  // ── Phase 1: Unused wine definitions ──────────────────────────────────────

  const allWineIds = await WineDefinition.distinct('_id');
  console.log(`Wine definitions total:  ${allWineIds.length}`);

  const usedIds = await Bottle.distinct('wineDefinition', {
    wineDefinition: { $in: allWineIds }
  });
  const usedSet = new Set(usedIds.map(id => id.toString()));
  const unusedIds = allWineIds.filter(id => !usedSet.has(id.toString()));
  console.log(`Wines with no bottles:   ${unusedIds.length}`);

  if (unusedIds.length > 0) {
    const profileResult = await WineVintageProfile.deleteMany({
      wineDefinition: { $in: unusedIds }
    });
    console.log(`Deleted vintage profiles: ${profileResult.deletedCount}`);

    const wineResult = await WineDefinition.deleteMany({ _id: { $in: unusedIds } });
    console.log(`Deleted wine definitions: ${wineResult.deletedCount}`);

    try {
      await searchService.initialize();
      for (const id of unusedIds) {
        await searchService.removeWine(id);
      }
      console.log('Removed deleted wines from Meilisearch index.');
    } catch (err) {
      console.warn(`Meilisearch cleanup skipped: ${err.message}`);
    }
  } else {
    console.log('No unused wine definitions — skipping wine cleanup.');
  }

  // ── Phase 2: Orphaned taxonomy ────────────────────────────────────────────
  console.log('');

  // Grapes — ObjectId refs in WineDefinition.grapes
  const usedGrapeIds = new Set(
    (await WineDefinition.distinct('grapes')).map(id => id.toString())
  );
  const allGrapes = await Grape.distinct('_id');
  const unusedGrapeIds = allGrapes.filter(id => !usedGrapeIds.has(id.toString()));
  console.log(`Grapes total:            ${allGrapes.length}  unused: ${unusedGrapeIds.length}`);
  if (unusedGrapeIds.length > 0) {
    const r = await Grape.deleteMany({ _id: { $in: unusedGrapeIds } });
    console.log(`Deleted grapes:          ${r.deletedCount}`);
  }

  // Regions — ObjectId ref in WineDefinition.region
  const usedRegionIds = new Set(
    (await WineDefinition.distinct('region')).filter(Boolean).map(id => id.toString())
  );
  const allRegions = await Region.distinct('_id');
  const unusedRegionIds = allRegions.filter(id => !usedRegionIds.has(id.toString()));
  console.log(`Regions total:           ${allRegions.length}  unused: ${unusedRegionIds.length}`);
  if (unusedRegionIds.length > 0) {
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
  if (unusedAppellationIds.length > 0) {
    const r = await Appellation.deleteMany({ _id: { $in: unusedAppellationIds } });
    console.log(`Deleted appellations:    ${r.deletedCount}`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
