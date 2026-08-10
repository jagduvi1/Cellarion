/**
 * The CROSS-FIELD check registry: rules that catch a registry value sitting in
 * the wrong FIELD by testing it against reference lists the app already holds
 * (ticket analysis 2026-08-10 §2 Class A — 16 prod records, one behaviour: a
 * label carries several strings and the parser/user assigns them to fields
 * with no test of whether the value belongs to that field's domain. The
 * strings are almost always correct and merely misplaced: producer
 * "Monbazillac" [an appellation], producer "Dragasani" [a region], region
 * "Spain" [a country], appellation "Cabernet Sauvignon" [a grape], producer
 * "Roșu Demidulce" [a style descriptor], producer "Domaine unknown" [a
 * placeholder], name "Wines" inside producer "The Freaky Wines", producer
 * "Trader Joe's (Bersano Estate)").
 *
 * REVIEW ONLY — this family flags, it never blocks a write. The create-time
 * hard gate (findOrCreateWine's producer-is-a-place 400) stays the only
 * blocker, and it only knows taxonomy that existed at mint time; this family
 * re-tests the whole registry against the LIVE lists on every scan, so every
 * appellation an admin promotes widens the net retroactively.
 *
 * A deliberate SIBLING of utils/nameChecks.js, not a bolt-on: those rules'
 * verdicts read NOTHING but name + producer — that invariant is what makes
 * verifiedChecks' two-field pre-validate invalidation complete. These rules
 * read the wine's placement fields (name, producer, appellation, region,
 * country) against the taxonomy collections, so they carry their own
 * clearance field (crossChecksCleared, invalidated on any of the six identity
 * fields — see the field comment in models/WineDefinition.js).
 *
 * Rule ids are VERSIONED, same discipline as nameChecks: refining a rule
 * means bumping its id in the same commit that edits its detect(), which
 * invalidates that rule's clearances registry-wide while leaving every other
 * rule's work intact. crossFieldChecks.snapshot.test.js pins each detect
 * body's source and FAILS on an un-snapshotted edit, so the bump cannot be
 * forgotten silently.
 *
 * Residual, stated honestly — twice over here: (1) as in nameChecks, an edit
 * to a shared helper (normalizeString, resolveCountryName, isUnknownName)
 * alters verdicts without altering any detect body; those helpers carry their
 * own suites. (2) Verdicts also depend on the loaded reference SETS, so a
 * taxonomy doc created or renamed tomorrow changes what fires with no code
 * change at all. That is the point — but it also means a clearance can
 * outlive the taxonomy state it was judged against; the scan's audit view
 * (ignoreCleared) exists to re-examine.
 */
const {
  normalizeString,
  normalizeAppellationKey,
  resolveCountryName,
  resolveGrapeName,
  isRecognizedCountry,
  isUnknownName,
} = require('./normalize');

/**
 * Probe a reference map with BOTH normalization folds of a wine-side value,
 * mirroring findOrCreateWine's dual-key appellation lookup (~line 388 there):
 * stored Appellation keys may carry either the legacy normalizeString fold
 * ("chateauneufdupape") or the current normalizeAppellationKey fold
 * ("chateauneuf du pape") until the backfill has run — and for the
 * normalizeString-keyed collections (Region/Country/Grape) the WINE-side
 * value may itself contain hyphens that the two folds treat differently.
 * Testing both probe forms against as-stored keys covers every combination.
 *
 * Maps (normalized key → display name) rather than Sets so a hit can report
 * WHAT it matched — the queue shows the entity, not a lowercase key.
 */
const lookupEntity = (map, value) => {
  const raw = String(value == null ? '' : value);
  if (!raw.trim()) return null;
  const plain = normalizeString(raw);
  const hyphenFolded = normalizeAppellationKey(raw);
  return (plain && map.get(plain)) ||
    (hyphenFolded && hyphenFolded !== plain && map.get(hyphenFolded)) || null;
};

/**
 * Build the preloaded reference maps every detect() runs against, from lean
 * taxonomy doc arrays ({ name, normalizedName, normalizedSynonyms }). Pure —
 * the async fetching lives in services/crossFieldScan.js. First doc wins on a
 * key collision (cross-country twins share a display name anyway).
 */
function buildCrossFieldRefs({ appellations = [], regions = [], countries = [], grapes = [] } = {}) {
  const toMap = (docs, withSynonyms) => {
    const map = new Map();
    for (const d of docs) {
      const keys = withSynonyms ? [d.normalizedName, ...(d.normalizedSynonyms || [])] : [d.normalizedName];
      for (const k of keys) if (k && !map.has(k)) map.set(k, d.name);
    }
    return map;
  };
  return {
    appellations: toMap(appellations, true),
    regions: toMap(regions, true),
    countries: toMap(countries, false),
    grapes: toMap(grapes, true),
  };
}

// Style vocabulary for producer-is-style-term, pre-normalized (normalizeString
// folds "Roșu" → 'rosu' and "off-dry" → 'offdry'; ß is NOT decomposable and
// would be stripped outright, so the detect pre-folds ß→ss before normalizing
// — "süß" → 'suss', "Weiß" → 'weiss'). Two tiers: STYLE words are EVIDENCE a
// string is a style descriptor; FILLER words merely don't count against it. A
// multi-token producer flags only when EVERY token is style-or-filler AND at
// least one is style — "Roșu Demidulce" flags, "Château Doux Rivage" must not
// (rivage is a real word).
const STYLE_WORDS = new Set([
  // sweetness / dryness scales across label languages
  'demidulce', 'demisec', 'dulce', 'seco', 'semiseco', 'semidulce',
  'abboccato', 'amabile', 'halbtrocken', 'feinherb', 'trocken', 'lieblich',
  'offdry', 'semisweet', 'moelleux', 'doux', 'brut', 'sec', 'dry', 'sweet',
  'suss', 'edes',
  // colour-as-style — the other half of the "Roșu Demidulce" prod row
  'rosu', 'alb', 'negru', 'rosso', 'bianco', 'rosato', 'tinto', 'blanco',
  'rouge', 'blanc', 'rose', 'rot', 'weiss', 'red', 'white',
]);
const STYLE_FILLER_WORDS = new Set([
  'vin', 'vino', 'wine', 'wein', 'de', 'du', 'le', 'la', 'el', 'il',
  'semi', 'demi',
]);

// Multi-word placeholder shapes; the single-token vocabulary (unknown / n/a /
// none / tbd / …) and the punctuation-only shapes ('-', '?' → '') are covered
// by the shared isUnknownName helper (utils/normalize.js).
const PLACEHOLDER_PRODUCERS = new Set([
  'domaine unknown', 'producer unknown', 'unknown producer', 'no producer',
  'winery unknown', 'unknown winery',
]);

// House/estate words whose presence as the ENTIRE shorter side disarms the
// name-in-producer containment rule — a name that is nothing but "Domaine" /
// "Bodegas" contained in its producer is legitimate estate branding, exactly
// the cohort nameChecks' ESTATE_WORDS exempts from name-equals-producer. A
// SEPARATE list on purpose — the same divergence-on-purpose convention that
// keeps ESTATE_WORDS separate from normalize.js WINE_STOP_WORDS: sharing
// would silently re-scope this rule's verdicts (and recorded clearances)
// whenever the sibling scan's list is re-tuned for its own reasons.
// Deliberately NOT widened with generic English trade words ('wines',
// 'estate', 'winery'): name "Wines" under producer "The Freaky Wines" is a
// real prod split this rule exists to catch.
const CONTAINMENT_HOUSE_WORDS = new Set([
  'chateau', 'chateaux', 'domaine', 'domaines', 'clos', 'mas', 'maison',
  'cave', 'caves', 'weingut', 'schloss', 'tenuta', 'tenute', 'castello',
  'cantina', 'cantine', 'azienda', 'fattoria', 'podere', 'poderi', 'cascina',
  'bodega', 'bodegas', 'vina', 'quinta', 'herdade', 'casa', 'finca',
]);

/**
 * Each rule:
 *   id            - stable, VERSIONED. Bump on refinement.
 *   labelKey      - i18n leaf under admin.wines.crossField.reasons.
 *   field         - which wine field the finding is about (drives the UI's
 *                   "offending field" column; not used by detection).
 *   defaultActive - included when the scan is called with no ?check.
 *   detect        - (wine, refs) => short detail string (what it matched) |
 *                   null. `wine` is the FLATTENED row the scan service builds:
 *                   region/country resolved to display-name strings, so every
 *                   rule stays pure and synchronous given the refs.
 */
const CROSS_FIELD_CHECKS = [
  {
    // "Monbazillac" as producer. Full-string matching only, by construction:
    // "Marchesi di Barolo" normalizes to 'marchesi di barolo', which is not
    // an appellation key, so estates NAMED AFTER their appellation pass.
    id: 'producer-is-appellation.v1',
    labelKey: 'producerIsAppellation',
    field: 'producer',
    defaultActive: true,
    detect: (w, refs) => lookupEntity(refs.appellations, w.producer),
  },
  {
    // "Dragasani" as producer — the mint-time place gate's blind spot when
    // the Region doc was created later in the same call (ticket §3).
    id: 'producer-is-region.v1',
    labelKey: 'producerIsRegion',
    field: 'producer',
    defaultActive: true,
    detect: (w, refs) => lookupEntity(refs.regions, w.producer),
  },
  {
    // Country docs first (what the registry actually links), then the static
    // recognized-country list so "India" flags even before a Country doc
    // exists. resolveCountryName folds aliases ("Spanien" → "Spain").
    id: 'producer-is-country.v1',
    labelKey: 'producerIsCountry',
    field: 'producer',
    defaultActive: true,
    detect: (w, refs) => {
      const producer = w.producer || '';
      if (!producer.trim()) return null;
      const canonical = resolveCountryName(producer);
      return lookupEntity(refs.countries, canonical) ||
        (isRecognizedCountry(producer) ? String(canonical).trim() : null);
    },
  },
  {
    // Grape docs + curated synonyms; the static GRAPE_SYNONYMS map is probed
    // too (via resolveGrapeName) because a producer can never legitimately be
    // a variety, so the wider list only adds true positives — unlike
    // appellation-is-grape below, where that map would misfire (Muscadet).
    id: 'producer-is-grape.v1',
    labelKey: 'producerIsGrape',
    field: 'producer',
    defaultActive: true,
    detect: (w, refs) => lookupEntity(refs.grapes, w.producer) ||
      lookupEntity(refs.grapes, resolveGrapeName(w.producer || '')),
  },
  {
    // "Roșu Demidulce" (= semi-sweet red) as producer. Every token must be a
    // style/filler word, with at least one style word — see the vocabulary
    // comment above for why "Château Doux Rivage" never flags. v2: pre-fold
    // ß→ss so "Süß"/"Weiß" reach the vocabulary (normalizeString deletes ß).
    id: 'producer-is-style-term.v2',
    labelKey: 'producerIsStyleTerm',
    field: 'producer',
    defaultActive: true,
    detect: (w) => {
      const tokens = normalizeString((w.producer || '').replace(/ß/g, 'ss')).split(' ').filter(Boolean);
      if (tokens.length === 0) return null;
      const matched = [];
      for (const t of tokens) {
        if (STYLE_WORDS.has(t)) matched.push(t);
        else if (!STYLE_FILLER_WORDS.has(t)) return null;
      }
      return matched.length ? matched.join(' ') : null;
    },
  },
  {
    // "Domaine unknown" as producer — the AI/import placeholder vocabulary
    // that isUnknownName screens out of taxonomy mints, here caught when it
    // landed in the producer field instead.
    id: 'producer-placeholder.v1',
    labelKey: 'producerPlaceholder',
    field: 'producer',
    defaultActive: true,
    detect: (w) => {
      const raw = (w.producer || '').trim();
      if (!raw) return null;
      return (isUnknownName(raw) || PLACEHOLDER_PRODUCERS.has(normalizeString(raw)))
        ? raw : null;
    },
  },
  {
    // "Trader Joe's (Bersano Estate)" — a parenthetical in a producer is a
    // second entity (the real estate behind a retail label, a sub-range, an
    // importer note) packed into one field. The detail is the parenthetical
    // itself: the part an admin most likely needs to move somewhere else.
    id: 'producer-parenthetical.v1',
    labelKey: 'producerParenthetical',
    field: 'producer',
    defaultActive: true,
    detect: (w) => {
      const producer = w.producer || '';
      const i = producer.indexOf('(');
      return i === -1 ? null : (producer.slice(i).trim() || producer.trim());
    },
  },
  {
    // Name "Wines" under producer "The Freaky Wines": one label string split
    // mid-phrase across the two fields. STRICT containment only — equality is
    // nameChecks' territory (name-equals-producer.v1) — aligned on whole
    // tokens so "Rioja"/"Riojanas" never pairs, with ≥3 chars of remainder so
    // near-equal spellings stay the fuzzy-duplicate scanner's problem. Both
    // directions on purpose: producer-⊂-name overlaps producer-in-name.v1
    // only on rows that are defects anyway (prefix/suffix embeds it strips),
    // and it alone catches the mid-name embeds that scan cannot see.
    id: 'name-in-producer.v1',
    labelKey: 'nameInProducer',
    field: 'name',
    defaultActive: true,
    detect: (w) => {
      const name = normalizeString(w.name || '');
      const producer = normalizeString(w.producer || '');
      if (!name || !producer || name === producer) return null;
      const nameIsShorter = name.length <= producer.length;
      const [shorter, longer] = nameIsShorter ? [name, producer] : [producer, name];
      if (longer.length - shorter.length < 3) return null;
      if (!` ${longer} `.includes(` ${shorter} `)) return null;
      if (shorter.split(' ').every(t => CONTAINMENT_HOUSE_WORDS.has(t))) return null;
      return (nameIsShorter ? w.name : w.producer).trim();
    },
  },
  {
    // "Cabernet Sauvignon" as appellation. Curated Grape docs/synonyms ONLY —
    // deliberately NOT resolveGrapeName's static map, whose keys include wine
    // names misused as grapes ("Muscadet" → Melon de Bourgogne) that are
    // LEGITIMATE appellations; probing it would flag every Muscadet.
    id: 'appellation-is-grape.v1',
    labelKey: 'appellationIsGrape',
    field: 'appellation',
    defaultActive: true,
    detect: (w, refs) => lookupEntity(refs.grapes, w.appellation),
  },
  {
    // Region "Spain". Not one of the plan section's nine pinned rules but in
    // the same ticket's own Tier-2 item-5 list ("region == a country") and in
    // the 16-record evidence — and nearly free here: wine.region is an
    // ObjectId, so the rule reads the RESOLVED display name the scan service
    // already attaches for the queue rows. Junk Region docs predating the
    // region-is-a-country mint gate keep getting reused; this surfaces every
    // wine still pointing at one.
    id: 'region-is-country.v1',
    labelKey: 'regionIsCountry',
    field: 'region',
    defaultActive: true,
    detect: (w, refs) => {
      const region = w.region || '';
      if (!region.trim()) return null;
      const canonical = resolveCountryName(region);
      return lookupEntity(refs.countries, canonical) ||
        (isRecognizedCountry(region) ? String(canonical).trim() : null);
    },
  },
];

const CROSS_FIELD_CHECK_IDS = CROSS_FIELD_CHECKS.map(c => c.id);
const DEFAULT_CROSS_FIELD_CHECK_IDS = CROSS_FIELD_CHECKS.filter(c => c.defaultActive).map(c => c.id);
const byId = new Map(CROSS_FIELD_CHECKS.map(c => [c.id, c]));

/** Operator-injection-safe lookup for an untrusted body/query value. */
const resolveCrossFieldCheck = (id) =>
  (typeof id === 'string' && byId.has(id) ? byId.get(id) : null);

/**
 * Run a set of rules against one FLATTENED wine row (region/country already
 * resolved to names — services/crossFieldScan.js builds it). Clearances come
 * from the wine's own crossChecksCleared (undefined on legacy rows — .lean()
 * applies no defaults, so guard it). Returns [{ check, detail }, …] or null
 * when clean.
 */
function runCrossFieldChecks(wine, refs, { checkIds = DEFAULT_CROSS_FIELD_CHECK_IDS, ignoreCleared = false } = {}) {
  const cleared = Array.isArray(wine.crossChecksCleared) ? wine.crossChecksCleared : [];
  const hits = [];
  for (const id of checkIds) {
    // Live lookup (not the load-time Map) so the rule list is the single
    // source of truth — the staleness contract test appends a rule and proves
    // clearances recorded before it existed cannot suppress it (the same
    // guarantee nameChecks pins).
    const check = CROSS_FIELD_CHECKS.find(c => c.id === id);
    if (!check) continue;
    if (!ignoreCleared && cleared.includes(id)) continue;
    const detail = check.detect(wine, refs);
    if (!detail) continue;
    hits.push({ check: id, detail: String(detail) });
  }
  return hits.length ? hits : null;
}

/**
 * Wine fields the scan reads — every scan's .select() must cover these.
 * region/country arrive as ObjectIds here; the scan service resolves them to
 * names before the rules run.
 */
const CROSS_FIELD_CHECK_SELECT = 'name producer appellation region country crossChecksCleared';

module.exports = {
  CROSS_FIELD_CHECKS, CROSS_FIELD_CHECK_IDS, DEFAULT_CROSS_FIELD_CHECK_IDS,
  CROSS_FIELD_CHECK_SELECT, resolveCrossFieldCheck, runCrossFieldChecks,
  buildCrossFieldRefs,
};
