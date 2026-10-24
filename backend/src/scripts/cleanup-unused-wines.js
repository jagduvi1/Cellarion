/**
 * cleanup-unused-wines.js
 *
 * Deletes all WineDefinition records that nothing references anymore, then
 * removes orphaned taxonomy entries (Grapes, Regions, Appellations).
 * Bottles and user data are never touched.
 *
 * "Unused" means no reference from any model utils/wineRefs lists (every
 * model whose schema references a wine; its drift test fails when a new one
 * is not listed), except the cascade models below. The referencing paths are
 * read from the schemas, subdocuments included, so a new path on a listed
 * model counts without an edit here. A wine on a wishlist is by definition
 * not owned as a bottle — checking bottles alone would delete exactly those
 * wines and orphan the wishlist entries.
 *
 * For genuinely unused wines, also cascades (WINE_CASCADE_MODELS):
 *   - WineVintageProfile / WineVintagePrice records
 *   - WineEmbedding rows (they hold the vectors for similarity search)
 *   - CommunityWinePrice rows
 *   - WineNotDuplicate pairs involving the wine
 *   - RegistryDataValue rows (the wine's registry data)
 *   - Meilisearch index entries
 *
 * Taxonomy counts as used when any of REGION_REF_SOURCES / GRAPE_REF_SOURCES
 * references it, or (appellations, which wines carry as free text) when a
 * wine's appellation string folds to the doc's name or one of its synonyms,
 * tier suffix ("Barolo DOCG") stripped or not. Wines the first phase deletes,
 * and grapes deleted before the regions, keep nothing in use — in a dry run
 * too, so it reports what --apply deletes. Before deleting taxonomy rows,
 * --apply writes them to an NDJSON backup file.
 *
 * DRY-RUN BY DEFAULT — prints what would be deleted. Pass --apply to delete.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/cleanup-unused-wines.js
 *   docker exec cellarion-backend node src/scripts/cleanup-unused-wines.js --apply
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Grape = require('../models/Grape');
const Region = require('../models/Region');
const Appellation = require('../models/Appellation');
// Register remaining schemas so Mongoose doesn't complain about unknown refs
require('../models/Country');
const searchService = require('../services/search');
const { WINE_REF_HANDLED, WINE_REF_EXEMPT } = require('../utils/wineRefs');
const { normalizeAppellation, normalizeAppellationKey } = require('../utils/normalize');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

/**
 * Rows deleted together with an unused wine (model → label): they describe
 * the wine and mean nothing without it. Every other model in utils/wineRefs
 * keeps a wine in use.
 */
const WINE_CASCADE_MODELS = {
  WineVintageProfile: 'vintage profiles',
  WineVintagePrice: 'vintage prices',
  WineEmbedding: 'embeddings',
  CommunityWinePrice: 'community prices',
  WineNotDuplicate: 'not-duplicate pairs',
  RegistryDataValue: 'registry data values',
};

/** Every path in a schema, subdocuments and arrays included, that references the model `target`. */
function refPaths(schema, target, prefix = '') {
  const out = [];
  schema.eachPath((p, type) => {
    const ref = type.options?.ref || type.caster?.options?.ref;
    if (ref === target) out.push(prefix + p);
    if (type.schema) out.push(...refPaths(type.schema, target, `${prefix}${p}.`));
  });
  return out;
}

const wineRefModels = [...WINE_REF_HANDLED, ...Object.keys(WINE_REF_EXEMPT)]
  .map(name => require(`../models/${name}`));

/** All (model, path) pairs that hold a live reference to a WineDefinition. */
const WINE_REF_SOURCES = wineRefModels
  .filter(Model => !WINE_CASCADE_MODELS[Model.modelName])
  .flatMap(Model => refPaths(Model.schema, 'WineDefinition').map(p => [Model, p]));

/** (model, wine paths, label) for the rows deleted with an unused wine. */
const WINE_CASCADE = wineRefModels
  .filter(Model => WINE_CASCADE_MODELS[Model.modelName])
  .map(Model => [Model, refPaths(Model.schema, 'WineDefinition'), WINE_CASCADE_MODELS[Model.modelName]]);

/** All (model, path) pairs that keep a Region in use. */
const REGION_REF_SOURCES = [
  [WineDefinition, 'region'],
  [Region, 'parentRegion'],
  [Appellation, 'region'],
  // A grape's regionally correct display name for one place.
  [Grape, 'regionalNames.region'],
];

/** All (model, path) pairs that keep a Grape in use. */
const GRAPE_REF_SOURCES = [
  [WineDefinition, 'grapes'],
  [Region, 'typicalGrapes'],
  [Region, 'permittedGrapes'],
];

/**
 * Ids referenced through any of `sources`. References held by the rows in
 * `exclude` (Model → ids) don't count: an earlier step deletes those rows
 * (or, in a dry run, would), so a dry run reports what --apply deletes.
 */
async function referencedIds(sources, exclude = new Map()) {
  const used = new Set();
  for (const [Model, p] of sources) {
    const skip = exclude.get(Model);
    const filter = skip?.length ? { _id: { $nin: skip } } : {};
    for (const id of await Model.distinct(p, filter)) {
      if (id) used.add(id.toString());
    }
  }
  return used;
}

/** The appellation keys a wine's appellation string matches: as written and with its tier stripped. */
function appellationKeys(s) {
  return [normalizeAppellationKey(s), normalizeAppellationKey(normalizeAppellation(s) || s)].filter(Boolean);
}

/** The Appellation docs no wine's appellation string matches, by name or synonym. */
function unusedAppellations(appellations, wineAppellations) {
  const used = new Set(wineAppellations.filter(Boolean).flatMap(appellationKeys));
  return appellations.filter(a => ![a.normalizedName, normalizeAppellationKey(a.name || ''), ...(a.normalizedSynonyms || [])]
    .some(k => k && used.has(k)));
}

/**
 * Writes each taxonomy row to an NDJSON file (one `{ collection, doc }` per
 * line) right before it is deleted. The file exists from the first row.
 */
function createTaxonomyBackup(dir) {
  let file = null;
  let count = 0;
  return {
    append(collection, docs) {
      if (!docs.length) return;
      if (!file) file = path.join(dir, `cleanup-unused-wines-taxonomy-${Date.now()}.ndjson`);
      fs.appendFileSync(file, docs.map(doc => JSON.stringify({ collection, doc })).join('\n') + '\n');
      count += docs.length;
    },
    get file() { return file; },
    get count() { return count; },
  };
}

async function backupAndDelete(Model, ids, backup) {
  backup.append(Model.collection.collectionName, await Model.find({ _id: { $in: ids } }).lean());
  return Model.deleteMany({ _id: { $in: ids } });
}

async function cleanup({ apply = false, backupDir = os.tmpdir() } = {}) {
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN (pass --apply to delete)'}\n`);

  // ── Phase 1: Unused wine definitions ──────────────────────────────────────

  const allWineIds = await WineDefinition.distinct('_id');
  console.log(`Wine definitions total:  ${allWineIds.length}`);

  const usedSet = await referencedIds(WINE_REF_SOURCES);
  const unusedIds = allWineIds.filter(id => !usedSet.has(id.toString()));
  console.log(`Referenced anywhere:     ${usedSet.size}`);
  console.log(`Unreferenced wines:      ${unusedIds.length}`);

  if (unusedIds.length > 0 && apply) {
    for (const [Model, paths, label] of WINE_CASCADE) {
      const r = await Model.deleteMany({ $or: paths.map(p => ({ [p]: { $in: unusedIds } })) });
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
    console.log(`[dry-run] Would delete these wines and their ${Object.values(WINE_CASCADE_MODELS).join(', ')}.`);
  } else {
    console.log('No unused wine definitions — skipping wine cleanup.');
  }

  // ── Phase 2: Orphaned taxonomy ────────────────────────────────────────────
  console.log('');
  const backup = createTaxonomyBackup(backupDir);

  const usedGrapeIds = await referencedIds(GRAPE_REF_SOURCES, new Map([[WineDefinition, unusedIds]]));
  const allGrapes = await Grape.distinct('_id');
  const unusedGrapeIds = allGrapes.filter(id => !usedGrapeIds.has(id.toString()));
  console.log(`Grapes total:            ${allGrapes.length}  unused: ${unusedGrapeIds.length}`);
  if (unusedGrapeIds.length > 0 && apply) {
    const r = await backupAndDelete(Grape, unusedGrapeIds, backup);
    console.log(`Deleted grapes:          ${r.deletedCount}`);
  }

  const usedRegionIds = await referencedIds(REGION_REF_SOURCES, new Map([[WineDefinition, unusedIds], [Grape, unusedGrapeIds]]));
  const allRegions = await Region.distinct('_id');
  const unusedRegionIds = allRegions.filter(id => !usedRegionIds.has(id.toString()));
  console.log(`Regions total:           ${allRegions.length}  unused: ${unusedRegionIds.length}`);
  if (unusedRegionIds.length > 0 && apply) {
    const r = await backupAndDelete(Region, unusedRegionIds, backup);
    console.log(`Deleted regions:         ${r.deletedCount}`);
  }

  // Appellations — plain string in WineDefinition.appellation, folded the way
  // the write-time resolver folds it.
  const wineAppellations = await WineDefinition.distinct('appellation', unusedIds.length ? { _id: { $nin: unusedIds } } : {});
  const allAppellations = await Appellation.find({}, '_id name normalizedName normalizedSynonyms').lean();
  const unusedAppellationIds = unusedAppellations(allAppellations, wineAppellations).map(a => a._id);
  console.log(`Appellations total:      ${allAppellations.length}  unused: ${unusedAppellationIds.length}`);
  if (unusedAppellationIds.length > 0 && apply) {
    const r = await backupAndDelete(Appellation, unusedAppellationIds, backup);
    console.log(`Deleted appellations:    ${r.deletedCount}`);
  }

  if (backup.file) {
    console.log(`\nBackup of ${backup.count} taxonomy rows → ${backup.file} (container /tmp is ephemeral — copy it off)`);
  }
  console.log(apply ? '\nDone.' : '\nDry-run complete — nothing deleted. Re-run with --apply to delete.');
  return { unusedIds, unusedGrapeIds, unusedRegionIds, unusedAppellationIds, backupFile: backup.file };
}

if (require.main === module) {
  (async () => {
    console.log('Connecting to MongoDB…');
    await mongoose.connect(MONGO_URI);
    console.log('Connected.');
    await cleanup({ apply: process.argv.includes('--apply') });
    await mongoose.disconnect();
  })().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
  });
}

module.exports = {
  cleanup,
  refPaths,
  appellationKeys,
  unusedAppellations,
  WINE_CASCADE_MODELS,
  WINE_REF_SOURCES,
  WINE_CASCADE,
  REGION_REF_SOURCES,
  GRAPE_REF_SOURCES,
};
