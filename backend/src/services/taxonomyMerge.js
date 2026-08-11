/**
 * Taxonomy merge service — collapse a duplicate Grape/Region/Country document
 * into its canonical counterpart, rewriting every reference so the duplicate
 * can be deleted safely:
 *
 *   Grape   → WineDefinition.grapes, Region.typicalGrapes/permittedGrapes;
 *             duplicate's name + synonyms move into the canonical doc's
 *             synonyms[] so findOrCreateGrapes resolves the old name forever;
 *             regionalNames carry over (minus already-covered place pairs).
 *   Region  → WineDefinition.region, Region.parentRegion, Appellation.region,
 *             Grape.regionalNames.region; duplicate's name + synonyms move
 *             into canonical synonyms[] (same re-mint protection via
 *             findOrCreateRegion).
 *   Country → WineDefinition.country, Region.country, Appellation.country,
 *             Grape.regionalNames.country; colliding region names (unique
 *             per country) are merged first.
 *
 * Every function returns a summary object and never deletes until all
 * references are rewritten. Search reindexing of affected wines is included;
 * callers doing bulk runs can pass { resync: false } and fullSync() once at
 * the end instead (bottle documents denormalize taxonomy names too, so bulk
 * callers should also fullSyncBottles()).
 */

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const searchService = require('./search');
const { normalizeString } = require('../utils/normalize');

/** Load + validate the from/to pair for any taxonomy model. */
async function loadPair(Model, label, fromId, toId) {
  if (String(fromId) === String(toId)) {
    const err = new Error(`Cannot merge a ${label} into itself`);
    err.status = 400;
    throw err;
  }
  const [from, to] = await Promise.all([Model.findById(fromId), Model.findById(toId)]);
  if (!from || !to) {
    const err = new Error(`${label} not found: ${!from ? fromId : toId}`);
    err.status = 404;
    throw err;
  }
  return { from, to };
}

/**
 * Move `from`'s name and synonyms into `to.synonyms`, skipping anything that
 * normalizes to `to`'s own name or an existing synonym. Returns the names added.
 */
function absorbSynonyms(from, to) {
  const taken = new Set([normalizeString(to.name), ...(to.synonyms || []).map(normalizeString)]);
  const added = [];
  for (const candidate of [from.name, ...(from.synonyms || [])]) {
    const key = normalizeString(candidate);
    if (!key || taken.has(key)) continue;
    taken.add(key);
    added.push(candidate);
  }
  if (added.length) to.synonyms = [...(to.synonyms || []), ...added];
  return added;
}

/** Reindex a list of wine ids in Meilisearch (fire-and-forget, best effort). */
function reindexWines(wineIds) {
  for (const id of wineIds) {
    searchService.indexWine(id).catch(() => {});
  }
}

/**
 * Merge grape `fromId` into `toId`.
 * Pass `synonyms: false` when the duplicate's name is junk (a typo or a
 * "70% Monastrell"-style artifact) that must not survive as a synonym.
 * @returns {Promise<{winesUpdated:number, regionsUpdated:number, synonymsAdded:string[]}>}
 */
async function mergeGrapes(fromId, toId, { resync = true, synonyms = true } = {}) {
  const { from, to } = await loadPair(Grape, 'Grape', fromId, toId);

  const affectedWines = await WineDefinition.find({ grapes: from._id }).select('_id').lean();

  // Two-step swap: a wine may already list both grapes, so $addToSet first
  // (no duplicate), then $pull the old id from every wine that has it.
  await WineDefinition.updateMany({ grapes: from._id }, { $addToSet: { grapes: to._id } });
  await WineDefinition.updateMany({ grapes: from._id }, { $pull: { grapes: from._id } });

  let regionsUpdated = 0;
  for (const field of ['typicalGrapes', 'permittedGrapes']) {
    await Region.updateMany({ [field]: from._id }, { $addToSet: { [field]: to._id } });
    const res = await Region.updateMany({ [field]: from._id }, { $pull: { [field]: from._id } });
    regionsUpdated += res.modifiedCount;
  }

  const synonymsAdded = synonyms ? absorbSynonyms(from, to) : [];
  // Backfill enrichment the canonical doc lacks (merges never overwrite).
  for (const field of ['color', 'origin', 'agingPotential', 'prestige', 'description']) {
    if (!to[field] && from[field]) to[field] = from[field];
  }
  // Regional display names ride along: an entry is display data about the
  // VARIETY, so it must survive its duplicate doc. Pairs the canonical doc
  // already covers win (one name per place — the admin validator's
  // invariant). Ids compared as strings so ObjectIds and lean/hex forms
  // interoperate; a null/absent region IS the country-level pair. Carried
  // entries are copied as plain objects — never another doc's subdocuments.
  const pairKey = (e) => `${String(e.country)}:${e.region ? String(e.region) : ''}`;
  const takenPairs = new Set((to.regionalNames || []).map(pairKey));
  const carriedRegionalNames = (from.regionalNames || [])
    .filter(e => e && e.name && !takenPairs.has(pairKey(e)))
    .map(e => ({ country: e.country, region: e.region || null, name: e.name }));
  if (carriedRegionalNames.length) {
    to.regionalNames = [...(to.regionalNames || []), ...carriedRegionalNames];
  }
  await to.save(); // pre-save hook refreshes normalizedSynonyms

  await from.deleteOne();

  if (resync) reindexWines(affectedWines.map(w => w._id));

  return { winesUpdated: affectedWines.length, regionsUpdated, synonymsAdded };
}

/**
 * Merge region `fromId` into `toId`. Both regions must belong to the same
 * country — cross-country merges would desync WineDefinition.country.
 * Pass `synonyms: false` when the duplicate's name is junk (an "X or Y"
 * label-scan artifact, or a name that belongs to a different place) that
 * must not survive as a synonym on the canonical region.
 * @returns {Promise<{winesUpdated:number, childRegionsUpdated:number, appellationsUpdated:number, synonymsAdded:string[]}>}
 */
async function mergeRegions(fromId, toId, { resync = true, synonyms = true } = {}) {
  const { from, to } = await loadPair(Region, 'Region', fromId, toId);
  if (String(from.country) !== String(to.country)) {
    const err = new Error('Cannot merge regions from different countries');
    err.status = 400;
    throw err;
  }
  return mergeRegionDocs(from, to, { resync, synonyms });
}

/** Reference rewrite + delete for a loaded region pair (no country check —
 *  mergeCountries needs this for name collisions across the two countries). */
async function mergeRegionDocs(from, to, { resync = true, synonyms = true } = {}) {
  const affectedWines = await WineDefinition.find({ region: from._id }).select('_id').lean();
  await WineDefinition.updateMany({ region: from._id }, { $set: { region: to._id } });

  const children = await Region.updateMany({ parentRegion: from._id }, { $set: { parentRegion: to._id } });
  const apps = await Appellation.updateMany({ region: from._id }, { $set: { region: to._id } });

  // Grape regional display names scope to regions too — re-point them with
  // the other refs so resolution keeps working after the duplicate goes.
  // A re-point CAN leave a duplicate (country, region) pair on a grape that
  // carried entries for both regions; that residue is acceptable by design:
  // resolution is first-match and the admin validator blocks NEW duplicates
  // on the next edit.
  await Grape.updateMany(
    { 'regionalNames.region': from._id },
    { $set: { 'regionalNames.$[e].region': to._id } },
    { arrayFilters: [{ 'e.region': from._id }] }
  );

  const synonymsAdded = synonyms ? absorbSynonyms(from, to) : [];
  for (const field of ['classification', 'prestigeLevel', 'description']) {
    if (!to[field] && from[field]) to[field] = from[field];
  }
  for (const field of ['styles', 'typicalGrapes', 'permittedGrapes']) {
    const have = new Set((to[field] || []).map(String));
    const extra = (from[field] || []).filter(v => !have.has(String(v)));
    if (extra.length) to[field] = [...(to[field] || []), ...extra];
  }
  await to.save();

  await from.deleteOne();

  if (resync) reindexWines(affectedWines.map(w => w._id));

  return {
    winesUpdated: affectedWines.length,
    childRegionsUpdated: children.modifiedCount,
    appellationsUpdated: apps.modifiedCount,
    synonymsAdded,
  };
}

/**
 * Merge country `fromId` into `toId`. Regions whose name collides with one
 * already under the target country (unique {country, normalizedName} index)
 * are merged into that region; the rest are re-parented.
 * @returns {Promise<{winesUpdated:number, regionsMoved:number, regionsMerged:number, appellationsUpdated:number}>}
 */
async function mergeCountries(fromId, toId, { resync = true } = {}) {
  const { from, to } = await loadPair(Country, 'Country', fromId, toId);

  // Re-parent (or merge) every region under the duplicate country first, so
  // the unique {country, normalizedName} index can never abort mid-run.
  const fromRegions = await Region.find({ country: from._id });
  let regionsMoved = 0;
  let regionsMerged = 0;
  for (const region of fromRegions) {
    const collision = await Region.findOne({
      country: to._id,
      normalizedName: region.normalizedName,
    });
    if (collision) {
      // Same name already exists under the target country — fold the
      // duplicate's references into it (never move first: the unique
      // {country, normalizedName} index would reject the move).
      await mergeRegionDocs(region, collision, { resync: false });
      regionsMerged += 1;
    } else {
      await Region.updateOne({ _id: region._id }, { $set: { country: to._id } });
      regionsMoved += 1;
    }
  }

  const affectedWines = await WineDefinition.find({ country: from._id }).select('_id').lean();
  await WineDefinition.updateMany({ country: from._id }, { $set: { country: to._id } });
  const apps = await Appellation.updateMany({ country: from._id }, { $set: { country: to._id } });

  // Country-level grape regional display names follow the country merge.
  // Duplicate-pair residue is acceptable for the same reason as in
  // mergeRegionDocs: first-match resolution + validator blocks new dupes.
  await Grape.updateMany(
    { 'regionalNames.country': from._id },
    { $set: { 'regionalNames.$[e].country': to._id } },
    { arrayFilters: [{ 'e.country': from._id }] }
  );

  await from.deleteOne();

  if (resync) reindexWines(affectedWines.map(w => w._id));

  return {
    winesUpdated: affectedWines.length,
    regionsMoved,
    regionsMerged,
    appellationsUpdated: apps.modifiedCount,
  };
}

module.exports = { mergeGrapes, mergeRegions, mergeCountries };
