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
  IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS,
  CROSS_FIELD_CHECK_SELECT,
  buildCrossFieldRefs,
  runCrossFieldChecks,
  detectPlacePlusFillerProducer,
  SCAN_SUSPECT_PLACE_FILLER_ID,
} = require('../utils/crossFieldChecks');
const { normalizeString, normalizeProducerKey, calculateSimilarity } = require('../utils/normalize');

/** The DB-backed rule this file computes (declared in utils/crossFieldChecks). */
const CUVEE_NEAR_MISS = 'cuvee-near-miss.v2';

/**
 * How alike two names from ONE producer have to be before the pair reads as a
 * misread rather than two cuvées.
 *
 * Levenshtein ratio (utils/normalize.calculateSimilarity), not the composite
 * combinedSimilarity: the signature is CHARACTER-level ("Alexandre" /
 * "Alexandra", "Vieilles" / "Vielles"), and the composite's token-Jaccard third
 * scores exactly that shape LOWER than an honest suffix addition
 * ("Chardonnay" / "Chardonnay Reserve"), which is the opposite of what this
 * rule wants.
 *
 * 0.78, not 0.85 (audit M-6), and the lower bar is only safe because of
 * NUMERIC_TOKEN_DIFF below: the extra pairs a looser threshold buys are
 * overwhelmingly vintage/lot digits ("Reserva 2010" ~ "Reserva 2011" = 0.92,
 * "Valbuena 5" ~ "Valbuena 3" = 0.90), and those are now disqualified outright.
 *
 * STATED HONESTLY — 0.78 still does NOT reach the row this rule was written for.
 * Measured, not assumed:
 *     calculateSimilarity('coeur de roi', 'coeur de roches') = 0.7333
 *     (and the pair AS STORED is worse still: normalizeString deletes the œ
 *      ligature, so "Cœur de Roches" folds to 'cur de roches' → 0.5385)
 * while the nearest same-producer pair that must NEVER flag —
 *     'brunello di montalcino' ~ 'rosso di montalcino' = 0.7273, two real wines
 *     hundreds of Montalcino estates both make —
 * sits 0.006 below it. There is no threshold that separates them, so no
 * threshold is set there: 0.78 widens the net as far as it can go before
 * ordinary range pairs start arriving. Catching "Roi"/"Roches" needs evidence
 * this rule does not have (the label photo), which is what the pending-identity
 * queue and its 7-day scan window are for.
 */
const NEAR_MISS_MIN_SIMILARITY = 0.78;
// Short names hit high edit-distance ratios by accident ("Brut" / "Brun").
const NEAR_MISS_MIN_LENGTH = 6;
/**
 * Do two names differ ONLY in numeric tokens?
 *
 * "Reserva 2010" / "Reserva 2011" and "Valbuena 5" / "Valbuena 3" are the two
 * shapes that flood this rule once the threshold is loosened, and neither is a
 * misread: a vintage or a lot number IS the distinction between two real,
 * separate wines. A vision misread changes LETTERS ("roi" → "roches",
 * "Alexandre" → "Alexandra"); if every token that differs is digits, the pair is
 * a range, not a mistake.
 *
 * Compared on raw normalized tokens (not `tokenize`) so nothing is dropped
 * before the diff — a stop word that differs is still a letter difference.
 */
const NUMERIC_TOKEN_DIFF = (aNorm, bNorm) => {
  const a = aNorm.split(' ').filter(Boolean);
  const b = bNorm.split(' ').filter(Boolean);
  const aSet = new Set(a);
  const bSet = new Set(b);
  const differing = [...a.filter((t) => !bSet.has(t)), ...b.filter((t) => !aSet.has(t))];
  return differing.length > 0 && differing.every((t) => /^\d+$/.test(t));
};

// One producer with a very large range would make the O(n²) pass the dominant
// cost of the whole scan; above this the group is skipped and reported nowhere.
// No real winery's registry range is anywhere near it.
const NEAR_MISS_MAX_GROUP = 200;

/**
 * cuvee-near-miss.v2 — for each wine, the SAME PRODUCER's most similar other
 * name, when it is nearly but not exactly the same string.
 *
 * Grouped on normalizeProducerKey so a producer's own spelling variants
 * ("Felton Road" / "Felton Road Wines Ltd") stay one range; the empty key
 * (a producerless row) is skipped entirely — those are pending rows, which the
 * scan already excludes, and grouping them all together would compare
 * strangers' wines to each other.
 *
 * CONTAINMENT is not a near miss: "Gran Reserva" beside "Gran Reserva 904" is
 * a range, not a misread, and it scores high on any string metric. Whole-name
 * containment (either direction) disqualifies the pair before scoring. Nor is a
 * NUMERIC-ONLY difference (NUMERIC_TOKEN_DIFF) — "Reserva 2010"/"Reserva 2011".
 *
 * @param {Array<{_id, name, producer}>} wines  flattened rows
 * @returns {Map<string, string>} wineId → the other wine's name
 */
function detectCuveeNearMiss(wines) {
  const groups = new Map();
  for (const w of wines) {
    const key = normalizeProducerKey(w.producer || '');
    if (!key) continue;
    const norm = normalizeString(w.name || '');
    if (norm.length < NEAR_MISS_MIN_LENGTH) continue;
    const list = groups.get(key) || [];
    list.push({ _id: String(w._id), name: w.name, norm });
    groups.set(key, list);
  }

  const hits = new Map();
  for (const list of groups.values()) {
    if (list.length < 2 || list.length > NEAR_MISS_MAX_GROUP) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.norm === b.norm) continue;                       // identical is the duplicate scanner's problem
        if (a.norm.includes(b.norm) || b.norm.includes(a.norm)) continue;
        // A vintage or lot number is a real distinction, never a misread (M-6).
        if (NUMERIC_TOKEN_DIFF(a.norm, b.norm)) continue;
        if (calculateSimilarity(a.norm, b.norm) < NEAR_MISS_MIN_SIMILARITY) continue;
        // BOTH rows are flagged, each naming the other: a curator cannot tell
        // from one row alone which of the two is the misread.
        if (!hits.has(a._id)) hits.set(a._id, b.name);
        if (!hits.has(b._id)) hits.set(b._id, a.name);
      }
    }
  }
  return hits;
}

/**
 * One round-trip per taxonomy collection; refs + id→name maps from the same
 * rows. MEMOIZED for 45s (release-audit MED-2): the mint gate calls this once
 * per CREATED wine, and a 300-row import paid the four collection loads 300
 * times. The rules already tolerate taxonomy staleness by design (module
 * header, residual 2), so a sub-minute cache changes no verdict that matters —
 * a just-promoted appellation is picked up on the next window.
 */
let contextCache = null;
let contextCacheAt = 0;
const CONTEXT_TTL_MS = 45 * 1000;
async function loadContext() {
  // Disabled under jest: module-level state outlives clearAllMocks, and a
  // cached refs object would silently bleed one test's taxonomy fixtures into
  // the next. Production and one-off scripts get the cache.
  if (process.env.NODE_ENV !== 'test'
      && contextCache && Date.now() - contextCacheAt < CONTEXT_TTL_MS) return contextCache;
  const fresh = await loadContextUncached();
  contextCache = fresh;
  contextCacheAt = Date.now();
  return fresh;
}
async function loadContextUncached() {
  const [appellations, regions, countries, grapes] = await Promise.all([
    Appellation.find({}).select('name normalizedName normalizedSynonyms').lean(),
    Region.find({}).select('name normalizedName normalizedSynonyms').lean(),
    Country.find({}).select('name normalizedName').lean(),
    Grape.find({}).select('name normalizedName normalizedSynonyms color').lean(),
  ]);
  return {
    refs: buildCrossFieldRefs({ appellations, regions, countries, grapes }),
    regionNamesById: new Map(regions.map(r => [String(r._id), r.name])),
    countryNamesById: new Map(countries.map(c => [String(c._id), c.name])),
    // id → { name, color } for grape-colour-contradiction.v1. Same
    // fetch-once-flatten-in-Node shape as the region/country name maps above;
    // `color` is null on ~2% of the taxonomy and the rule treats an unknown
    // colour as "not evaluable", never as a verdict.
    grapesById: new Map(grapes.map(g => [String(g._id), { name: g.name, color: g.color || null }])),
  };
}

/**
 * The row shape the rules (and the queue UI) consume: strings, plus the one
 * structured field grape-colour-contradiction.v1 needs.
 */
const flattenWine = (w, regionNamesById, countryNamesById, grapesById) => ({
  _id: w._id,
  // String-coerce: one raw-driver-written non-string row must not throw and
  // take the whole scan (and the weekly metrics run) down with it.
  name: w.name == null ? '' : String(w.name),
  producer: w.producer == null ? '' : String(w.producer),
  appellation: w.appellation || null,
  region: w.region ? (regionNamesById.get(String(w.region)) || null) : null,
  country: w.country ? (countryNamesById.get(String(w.country)) || null) : null,
  // Read only by colour-contradiction.v2 — the one rule in the family whose
  // verdict is about the wine's own colour rather than a reference list.
  type: w.type || null,
  // …and by grape-colour-contradiction.v1, which needs the same wine's grape
  // COLOURS. Resolved here rather than populated, so the scan keeps its one
  // query per collection. Unresolvable ids drop out and the rule then sees an
  // incomplete colour set, which it treats as not-evaluable.
  grapes: grapesById
    ? (w.grapes || []).map(id => grapesById.get(String(id))).filter(Boolean)
    : [],
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
  const { refs, regionNamesById, countryNamesById, grapesById } = await loadContext();
  const wines = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
    .select(CROSS_FIELD_CHECK_SELECT)
    .sort({ producer: 1, name: 1 })
    .lean();

  const rows = [];
  const ruleCounts = {};
  for (const id of checkIds) ruleCounts[id] = 0;
  let clearedCount = 0;

  const flatWines = wines.map(w => flattenWine(w, regionNamesById, countryNamesById, grapesById));
  // The DB-backed rule runs ONCE over the whole pool (it is a pairwise question,
  // not a per-row one), then merges into each row's hits below.
  const nearMiss = checkIds.includes(CUVEE_NEAR_MISS) ? detectCuveeNearMiss(flatWines) : new Map();

  for (const flat of flatWines) {
    const cleared = Array.isArray(flat.crossChecksCleared) ? flat.crossChecksCleared : [];
    const hits = runCrossFieldChecks(flat, refs, { checkIds, ignoreCleared }) || [];
    const twin = nearMiss.get(String(flat._id));
    // Same clearance semantics the pure rules get — per rule id, and ignored
    // in the audit view.
    if (twin && (ignoreCleared || !cleared.includes(CUVEE_NEAR_MISS))) {
      hits.push({ check: CUVEE_NEAR_MISS, detail: String(twin) });
    }
    if (hits.length) {
      for (const h of hits) ruleCounts[h.check] += 1;
      const { crossChecksCleared, ...wine } = flat;
      rows.push({ wine, hits, cleared: crossChecksCleared || [] });
    } else if (checkIds.some(id => cleared.includes(id))) {
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
  const { refs, regionNamesById, countryNamesById, grapesById } = await loadContext();
  const wines = await WineDefinition.find({ _id: { $in: wineIds } })
    .select(CROSS_FIELD_CHECK_SELECT)
    .lean();

  // cuvee-near-miss is a PAIRWISE verdict: it cannot be recomputed from the
  // selected rows alone, because the sibling that makes a name suspicious is
  // some other registry row. When the clearance touches that rule the whole
  // pool is loaded — the same full fetch the scan endpoint does on every page
  // view — so the recompute reproduces exactly what the admin saw. Skipped
  // entirely otherwise, which is the common case.
  let nearMiss = new Map();
  if (checkIds.includes(CUVEE_NEAR_MISS)) {
    const pool = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
      .select(CROSS_FIELD_CHECK_SELECT)
      .lean();
    nearMiss = detectCuveeNearMiss(pool.map(w => flattenWine(w, regionNamesById, countryNamesById, grapesById)));
  }

  const hitsById = new Map();
  for (const w of wines) {
    const flat = flattenWine(w, regionNamesById, countryNamesById, grapesById);
    const hits = (runCrossFieldChecks(flat, refs, { checkIds, ignoreCleared: true }) || []).map(h => h.check);
    if (nearMiss.has(String(w._id))) hits.push(CUVEE_NEAR_MISS);
    hitsById.set(String(w._id), hits);
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

/**
 * "Is this string a producer at all?" — the one-question form of the gate
 * above, for the two surfaces that have a CANDIDATE producer and no wine row to
 * hang it on: the mint chokepoint (services/findOrCreateWine, step 3) and the
 * label scanner (routes/wines.js POST /scan-label).
 *
 * Same rules, same evaluation, same DB context as
 * services/pendingWineOps.applyPendingFix — restricted to
 * IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS, the producer-is-not-a-producer
 * family. Wrapped here rather than repeated at each call site so the check id
 * list can never drift between the queue that refuses these strings and the
 * mint that must stop creating them.
 *
 * Returns the FIRST hit only: a caller acting on this has one decision to make
 * (file the row pending / mark the extraction suspect), and the first rule that
 * fires is the one worth telling a curator about.
 *
 * @param {{name?, producer?, appellation?, region?, country?}} values
 * @returns {Promise<{check: string, detail: string}|null>} null = usable
 */
async function detectBlockingProducerIssue(values) {
  const hits = await detectCrossFieldForValues(values, IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS);
  return hits && hits.length ? hits[0] : null;
}

/**
 * The SCAN-TIME variant: the six blocking rules first (hard — flag whatever
 * else is true), then the aggressive place-plus-filler heuristic (soft — the
 * caller applies it only when the registry matched nothing; see the rule's
 * comment in utils/crossFieldChecks for why it must never gate a write).
 * One taxonomy load serves both stages.
 *
 * @returns {Promise<{check, detail, hard: boolean}|null>}
 */
async function detectScanSuspectProducer(values) {
  const flat = {
    name: values.name == null ? '' : String(values.name),
    producer: values.producer == null ? '' : String(values.producer),
    appellation: values.appellation || null,
    region: null,
    country: null,
  };
  // A producer the Latin fold cannot represent ("獺祭", "Мукузани") is the
  // documented non-Latin KNOWN LIMIT, not a placeholder — isUnknownName reads
  // the empty fold as one and producer-placeholder.v1 would hard-flag every
  // such scan (release-audit HIGH-1). The extraction is fine; the mint path
  // already files these pending via its own length gate. No flag, no lookup.
  const { normalizeString } = require('../utils/normalize');
  if (flat.producer.trim() && !normalizeString(flat.producer)) return null;
  const { refs } = await loadContext();
  const hits = runCrossFieldChecks(flat, refs, {
    checkIds: IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS, ignoreCleared: true,
  });
  if (hits && hits.length) return { ...hits[0], hard: true };
  const soft = detectPlacePlusFillerProducer(flat.producer, refs);
  if (soft) {
    return {
      check: SCAN_SUSPECT_PLACE_FILLER_ID,
      detail: `"${soft.place}" + ${soft.filler}`,
      hard: false,
    };
  }
  return null;
}

module.exports = {
  scanCrossFieldChecks, detectCrossFieldForWines, detectCrossFieldForValues,
  detectBlockingProducerIssue, detectScanSuspectProducer,
  detectCuveeNearMiss, CUVEE_NEAR_MISS, NEAR_MISS_MIN_SIMILARITY,
};
