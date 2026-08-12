/**
 * Cross-field domain scan (ticket analysis 2026-08-10, Tier-2 item 5): apply
 * the utils/crossFieldChecks.js rules — "is this value sitting in the wrong
 * FIELD?" — across the registry. REVIEW QUEUE ONLY, pure reads: the rows feed
 * the admin Cross-field checks modal and the weekly watchdog's per-rule
 * counts; nothing here blocks a write.
 *
 * Load shape follows registryFragmentation (the newest sibling scan): the
 * four taxonomy collections are fetched ONCE per scan with minimal
 * projections (each is small — tens to hundreds of docs) and turned into
 * in-memory reference maps; the registry is fetched once with a short-field
 * projection and evaluated in Node. Same full-fetch pattern (and cost) as the
 * producer-in-name and duplicate-cluster scans, fine at the ~5.5k-row size.
 *
 * The same taxonomy fetch doubles as the region/country id → display-name
 * resolver, because wine.region/country are ObjectIds while the rules reason
 * over strings — so flattening costs no extra query.
 */
const WineDefinition = require('../models/WineDefinition');
const Appellation = require('../models/Appellation');
const Region = require('../models/Region');
const Country = require('../models/Country');
const Grape = require('../models/Grape');
const {
  DEFAULT_CROSS_FIELD_CHECK_IDS,
  CROSS_FIELD_CHECK_SELECT,
  buildCrossFieldRefs,
  runCrossFieldChecks,
} = require('../utils/crossFieldChecks');

/** One round-trip per taxonomy collection; refs + id→name maps from the same rows. */
async function loadContext() {
  const [appellations, regions, countries, grapes] = await Promise.all([
    Appellation.find({}).select('name normalizedName normalizedSynonyms').lean(),
    Region.find({}).select('name normalizedName normalizedSynonyms').lean(),
    Country.find({}).select('name normalizedName').lean(),
    Grape.find({}).select('name normalizedName normalizedSynonyms').lean(),
  ]);
  return {
    refs: buildCrossFieldRefs({ appellations, regions, countries, grapes }),
    regionNamesById: new Map(regions.map(r => [String(r._id), r.name])),
    countryNamesById: new Map(countries.map(c => [String(c._id), c.name])),
  };
}

/** The string-only row shape the rules (and the queue UI) consume. */
const flattenWine = (w, regionNamesById, countryNamesById) => ({
  _id: w._id,
  // String-coerce: one raw-driver-written non-string row must not throw and
  // take the whole scan (and the weekly metrics run) down with it.
  name: w.name == null ? '' : String(w.name),
  producer: w.producer == null ? '' : String(w.producer),
  appellation: w.appellation || null,
  region: w.region ? (regionNamesById.get(String(w.region)) || null) : null,
  country: w.country ? (countryNamesById.get(String(w.country)) || null) : null,
  crossChecksCleared: w.crossChecksCleared,
});

/**
 * Scan the registry (non-nonWine, the same exclusion contract as every other
 * admin scan pool) with clearance filtering.
 *
 * @returns {Promise<{rows: Array, ruleCounts: object, total: number,
 *   clearedCount: number, scannedCount: number}>}
 *   rows (ALL of them — pagination happens at the route layer), each:
 *   { wine: { _id, name, producer, appellation, region, country },
 *     hits: [{ check, detail }], cleared: [ruleId] }
 *   ruleCounts: outstanding flags per rule id across the whole registry —
 *   what the weekly watchdog snapshots.
 */
async function scanCrossFieldChecks({ checkIds = DEFAULT_CROSS_FIELD_CHECK_IDS, ignoreCleared = false } = {}) {
  const { refs, regionNamesById, countryNamesById } = await loadContext();
  const wines = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
    .select(CROSS_FIELD_CHECK_SELECT)
    .sort({ producer: 1, name: 1 })
    .lean();

  const rows = [];
  const ruleCounts = {};
  for (const id of checkIds) ruleCounts[id] = 0;
  let clearedCount = 0;

  for (const w of wines) {
    const flat = flattenWine(w, regionNamesById, countryNamesById);
    const hits = runCrossFieldChecks(flat, refs, { checkIds, ignoreCleared });
    if (hits) {
      for (const h of hits) ruleCounts[h.check] += 1;
      const { crossChecksCleared, ...wine } = flat;
      rows.push({ wine, hits, cleared: crossChecksCleared || [] });
    } else if (checkIds.some(id => (w.crossChecksCleared || []).includes(id))) {
      clearedCount += 1;
    }
  }

  return { rows, ruleCounts, total: rows.length, clearedCount, scannedCount: wines.length };
}

/**
 * Re-detect for the clearance write: which of `checkIds` does each of these
 * wines ACTUALLY trip right now? Clearances are ignored (the caller is about
 * to write them). Mirrors verify-checks' server-side recompute — a stale
 * client row must not be able to clear a rule the admin never saw on screen.
 *
 * @returns {Promise<Map<string, string[]>>} wineId → tripped rule ids
 *   (empty array = found but clean); ids absent from the map were not found.
 */
async function detectCrossFieldForWines(wineIds, checkIds) {
  const { refs, regionNamesById, countryNamesById } = await loadContext();
  const wines = await WineDefinition.find({ _id: { $in: wineIds } })
    .select(CROSS_FIELD_CHECK_SELECT)
    .lean();

  const hitsById = new Map();
  for (const w of wines) {
    const flat = flattenWine(w, regionNamesById, countryNamesById);
    const hits = runCrossFieldChecks(flat, refs, { checkIds, ignoreCleared: true });
    hitsById.set(String(w._id), hits ? hits.map(h => h.check) : []);
  }
  return hitsById;
}

/**
 * Run rules against an UNSAVED CANDIDATE row — the curation write path's
 * pre-flight (services/pendingWineOps.applyPendingFix refuses a fix that would
 * file a place or a grape in the producer box). Same loadContext, same rules,
 * no parallel rule set; clearances are ignored because the row does not exist
 * in this shape yet and nobody can have cleared it.
 *
 * Lives HERE, not in utils/crossFieldChecks, for the reason that splits the two
 * modules in the first place: these verdicts need the taxonomy collections, and
 * the rules module is pure.
 *
 * @param {{name?, producer?, appellation?, region?, country?}} values
 *   region/country as DISPLAY NAMES (the flattened shape the rules read), not
 *   ObjectIds — the caller has them in hand on this path.
 * @param {string[]} checkIds
 * @returns {Promise<Array<{check: string, detail: string}>|null>} null = clean
 */
async function detectCrossFieldForValues(values, checkIds = DEFAULT_CROSS_FIELD_CHECK_IDS) {
  const { refs } = await loadContext();
  const flat = {
    name: values.name == null ? '' : String(values.name),
    producer: values.producer == null ? '' : String(values.producer),
    appellation: values.appellation || null,
    region: values.region || null,
    country: values.country || null,
  };
  return runCrossFieldChecks(flat, refs, { checkIds, ignoreCleared: true });
}

module.exports = { scanCrossFieldChecks, detectCrossFieldForWines, detectCrossFieldForValues };
