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
 * REVIEW ONLY for the ~5.5k rows already in the registry — this family flags,
 * it never rewrites. The create-time hard gate (findOrCreateWine's
 * producer-is-a-place 400) knows only the taxonomy that existed at mint time;
 * this family re-tests the whole registry against the LIVE lists on every scan,
 * so every appellation an admin promotes widens the net retroactively.
 * ONE exception, added deliberately: the producer-is-not-a-producer subset is
 * ENFORCED on the pending-identity write path, where a curator is composing a
 * producer from scratch — see IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS below.
 *
 * Two kinds of rule live here. Most are PURE — `detect(wine, refs)` against the
 * preloaded reference maps. A few are DB-BACKED (DB_BACKED_CROSS_FIELD_CHECKS):
 * their verdict needs the registry itself, so they are declared here for the
 * queue's benefit and computed in services/crossFieldScan.js.
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
  tokenize,
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

// Colour words a wine NAME carries, mapped to the WineDefinition.type they
// imply. Pre-normalized (normalizeString folds "Rosé" → 'rose'; ß is not
// decomposable and would be stripped outright, so the detect pre-folds ß→ss
// exactly as producer-is-style-term.v2 does — "Weiß" → 'weiss').
//
// Deliberately EXACTLY the colour-of-the-wine vocabulary and no more. 'noir' /
// 'nero' / 'negro' are excluded on purpose even though they are colours: they
// name the GRAPE, not the wine ("Pinot Noir", "Nero d'Avola"), and "Blanc de
// Noirs" — a white or sparkling wine from black grapes — would flag on every
// single row. Known residual in the other direction: 'rose' is also an English
// noun, so a wine named "Wild Rose" flags. This family is a review queue, never
// a block, and a curator dismisses that in one click.
const NAME_COLOUR_TERMS = new Map([
  ['rose', 'rosé'], ['rosato', 'rosé'], ['rosado', 'rosé'], ['blush', 'rosé'],
  ['rouge', 'red'], ['tinto', 'red'], ['rosso', 'red'], ['rot', 'red'], ['red', 'red'],
  ['blanc', 'white'], ['blanco', 'white'], ['bianco', 'white'], ['branco', 'white'],
  ['weiss', 'white'], ['white', 'white'],
]);

// The types that ARE a colour. A contradiction can only be judged against one
// of these three: 'sparkling', 'dessert' and 'fortified' say nothing about
// colour, so "Blanc de Blancs" (sparkling) and "Bianco Passito" (dessert) must
// never flag — and those are the wines whose names carry colour words most
// often.
const COLOUR_TYPES = new Set(['red', 'white', 'rosé']);

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
    // Producer "Increíble", name "Increíble" — the label's one readable word
    // echoed into both boxes by the scan.
    //
    // THIS RULE IS A FLAG, AND THAT IS THE WHOLE POINT. The same suspicion used
    // to live in utils/normalize.isImplausibleIdentity, where it BLOCKED
    // promotion — and blocking it condemned an entire category of real wine:
    // producer == name is the SINGLE-WINE ESTATE (Château Margaux, Petrus,
    // Krug, Salon, Opus One, Sassicaia, Masseto, Château Rayas, J.J. Prüm), and
    // the containment half condemned Domaine de la Romanée-Conti / "Romanée-
    // Conti", Harlan Estate / "Harlan", Duckhorn / "Duckhorn Vineyards". 67 of
    // 91 sampled real pairs. Nothing in the STRING distinguishes those from the
    // "Increíble" echo; only a person looking at the label can.
    //
    // So the "Increíble" case is now SURFACED here rather than buried in a
    // refusal a curator could not see or overrule: it lands in this queue like
    // every other rule, and a real single-estate wine is cleared once with the
    // existing per-rule clearing mechanism (crossChecksCleared) and never asks
    // again. Meanwhile P2's 7-day post-promotion scan window keeps the label
    // photo readable while a curator judges it — which is exactly the evidence
    // the original prod row no longer had.
    //
    // Overlaps nameChecks' name-equals-producer.v1 on the equality half, on
    // purpose: that suite is a different queue with a different clearance field
    // (verifiedChecks), and the placement queue is where a curator working
    // producer defects actually looks.
    id: 'producer-echoes-name.v1',
    labelKey: 'producerEchoesName',
    field: 'producer',
    defaultActive: true,
    detect: (w) => {
      const p = normalizeString(w.producer || '');
      const n = normalizeString(w.name || '');
      if (!p || !n) return null;
      if (p === n) return `${w.producer.trim()} = ${w.name.trim()}`;
      // Containment leaving NO DISTINCT remainder on either side, compared on
      // stop-word-stripped tokens — "Increíble Wines" / "Increíble" is the same
      // echo wearing an estate word, while "Cloudy Bay" / "Cloudy Bay Sauvignon
      // Blanc" leaves 'sauvignon blanc' and is a real (if badly formatted) row.
      const pTok = tokenize(w.producer || '');
      const nTok = tokenize(w.name || '');
      // All-stop-word sides are utils/normalize.isImplausibleIdentity's
      // business (it still BLOCKS a producer that is only house words) and
      // comparing two empty token lists would flag every such pair twice.
      if (!pTok.length || !nTok.length) return null;
      const pSet = new Set(pTok);
      const nSet = new Set(nTok);
      if (pTok.some((t) => !nSet.has(t)) || nTok.some((t) => !pSet.has(t))) return null;
      return `${w.producer.trim()} = ${w.name.trim()}`;
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
  {
    // Domaine Rolet, name "Rosé Poulsard", type `red` (sommelier ticket 3).
    // The label says one colour and the record says another; whichever is
    // wrong, a drinker filtering by type gets the wrong bottle and the
    // maturity curve is computed for the wrong style. Pure string test — the
    // only rule in this family that reads `type`, which is why `type` joins
    // CROSS_FIELD_CHECK_SELECT and the crossChecksCleared invalidation set.
    // v2 (audit L-7): two exemptions, both measured against real rows.
    //   (a) a colour word that is also in the PRODUCER string is the ESTATE's
    //       name, not a claim about the wine — "Cheval Blanc" (a red),
    //       "Mas Blanc", "Clos Blanc". The name repeats the house; the house is
    //       not evidence of colour.
    //   (b) "White <grape>" on a rosé is the American label convention for a
    //       rosé pressed off a black grape — "White Zinfandel", "White Merlot".
    //       Judged against the live Grape refs rather than a hardcoded list, so
    //       it widens with the taxonomy exactly as the rest of this family does.
    id: 'colour-contradiction.v2',
    labelKey: 'colourContradiction',
    field: 'type',
    defaultActive: true,
    detect: (w, refs) => {
      const type = w.type;
      if (!COLOUR_TYPES.has(type)) return null;
      const producerTokens = new Set(
        normalizeString((w.producer || '').replace(/ß/g, 'ss')).split(' ').filter(Boolean)
      );
      const tokens = normalizeString((w.name || '').replace(/ß/g, 'ss')).split(' ').filter(Boolean);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const implied = NAME_COLOUR_TERMS.get(t);
        if (!implied || implied === type) continue;
        if (producerTokens.has(t)) continue;                                    // (a)
        if (type === 'rosé' && implied === 'white' &&
            lookupEntity(refs?.grapes || new Map(), tokens[i + 1] || '')) continue; // (b)
        return `${t} → ${implied}, stored as ${type}`;
      }
      return null;
    },
  },
];

/**
 * DB-BACKED rules: same queue, same clearance record, same versioned ids — but
 * their verdict needs the REGISTRY, not just reference lists, so they cannot be
 * a pure `detect(wine, refs)` and are computed in services/crossFieldScan.js
 * instead. Declared here anyway so there is ONE list of what the queue can
 * show: the route's label/field maps, the ?check= validator and the clearance
 * endpoints all resolve against these too.
 *
 * runCrossFieldChecks skips them by construction (it looks each id up in
 * CROSS_FIELD_CHECKS and continues when there is no rule with a detect), so a
 * caller may pass a mixed id list without special-casing.
 */
const DB_BACKED_CROSS_FIELD_CHECKS = [
  {
    // Frédéric Magnien "Coeur de Roi" beside the real "Cœur de Roches"
    // (sommelier ticket 3) — the VISION-MISREAD signature: one producer, two
    // names that are nearly but not quite the same string. Not the duplicate
    // scanner's job (that hunts the same wine entered twice, across the whole
    // registry, and its threshold is tuned for merging); this hunts a name the
    // scanner got slightly WRONG, which is only ever suspicious within one
    // producer's own range. FLAG ONLY — a producer really can own two
    // similarly-named cuvées, so nothing is ever changed automatically.
    //
    // v2 (audit M-6): threshold 0.85 → 0.78, and a NUMERIC-ONLY difference is
    // now disqualified — "Reserva 2010"/"Reserva 2011" and "Valbuena 5"/
    // "Valbuena 3" score above ANY threshold and are different wines, not
    // misreads. The threshold comment in services/crossFieldScan states what
    // 0.78 still does not reach, and why no threshold reaches it.
    id: 'cuvee-near-miss.v2',
    labelKey: 'cuveeNearMiss',
    field: 'name',
    defaultActive: true,
    dbBacked: true,
  },
];

/** Everything the queue can show — pure rules first, then the DB-backed ones. */
const ALL_CROSS_FIELD_CHECKS = [...CROSS_FIELD_CHECKS, ...DB_BACKED_CROSS_FIELD_CHECKS];

/**
 * The subset the CURATION WRITE PATH refuses on, rather than merely flagging
 * (services/pendingWineOps.applyPendingFix).
 *
 * The family is REVIEW-ONLY by default — see the module header — and that does
 * not change for the ~5.5k rows already in the registry. But a curator
 * completing a pending identity is writing a producer FROM SCRATCH, and these
 * six rules all say the same thing about that write: the string is not a
 * producer at all. findOrCreateWine's mint gate already refuses three of them
 * (place-as-producer) on the deliberate curation surfaces; running them here
 * closes the same hole on the queue, where the DB lookups they need are allowed
 * (the pre-validate hook's shape test cannot do I/O).
 *
 * Deliberately NOT the whole list. name-in-producer.v1, producer-parenthetical
 * .v1, appellation-is-grape.v1 and region-is-country.v1 flag records that are
 * real but badly FORMATTED — "Cloudy Bay" under name "Cloudy Bay Sauvignon
 * Blanc" trips name-in-producer, and refusing that would trap a wine whose
 * curator transcribed the label correctly. Those stay in the review queue.
 *
 * And emphatically NOT producer-echoes-name.v1. Refusing producer == name is
 * how the previous revision condemned Château Margaux, Petrus, Krug, Salon and
 * 63 other real single-wine estates; that rule exists to be LOOKED AT, never to
 * refuse a write. See its comment above.
 */
const IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS = [
  'producer-is-appellation.v1',
  'producer-is-region.v1',
  'producer-is-country.v1',
  'producer-is-grape.v1',
  'producer-is-style-term.v2',
  'producer-placeholder.v1',
];

const CROSS_FIELD_CHECK_IDS = ALL_CROSS_FIELD_CHECKS.map(c => c.id);
const DEFAULT_CROSS_FIELD_CHECK_IDS = ALL_CROSS_FIELD_CHECKS.filter(c => c.defaultActive).map(c => c.id);
const byId = new Map(ALL_CROSS_FIELD_CHECKS.map(c => [c.id, c]));

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
    // guarantee nameChecks pins). Deliberately searches the PURE list only: a
    // DB-backed id (cuvee-near-miss.v2) has no detect and is computed by
    // services/crossFieldScan, so it falls through here rather than needing a
    // special case at every call site.
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
const CROSS_FIELD_CHECK_SELECT = 'name producer appellation region country type crossChecksCleared';

/** id → i18n leaf / offending field, for the admin queue's column headers. */
const CROSS_FIELD_CHECK_LABEL_KEYS = ALL_CROSS_FIELD_CHECKS.reduce((m, c) => (m[c.id] = c.labelKey, m), {});
const CROSS_FIELD_CHECK_FIELDS = ALL_CROSS_FIELD_CHECKS.reduce((m, c) => (m[c.id] = c.field, m), {});

// ── SCAN-ONLY place-plus-filler heuristic ───────────────────────────────────
//
// The prod row that motivated it: a label scan extracted producer "Pays d'Oc
// Organic Wine" — an APPELLATION padded with marketing words. None of the six
// blocking rules fire on it (they are full-string matches, and 'organic' is
// neither style nor filler in their vocabularies), so it minted as a normal
// published wine.
//
// This rule flags a producer whose tokens are a known place name (appellation,
// region or country) plus NOTHING but filler. It is deliberately AGGRESSIVE —
// "Château Margaux" trips it (margaux = appellation, chateau = filler), and
// that is exactly why it is SCAN-ONLY and must never gate a write: estates
// named after their place are an entire legitimate category (the #942 lesson).
// At scan time the flag's whole cost is the editable prefilled form plus the
// back-label offer instead of the one-tap card, and the route only applies it
// when the registry matched nothing — a famous estate resolves to its
// registry row and never sees the flag. Wrong-but-cheap beats right-but-rare
// there; nowhere else.
const SCAN_SUSPECT_PLACE_FILLER_ID = 'producer-place-plus-filler.scan';

// Filler vocabulary for the scan heuristic — wider than STYLE_FILLER_WORDS and
// the containment list on purpose (trade/marketing words are exactly the
// padding this rule exists to see through), and NOT shared with them: the same
// divergence-on-purpose convention as everywhere else in this file, so tuning
// this scan-UX rule can never silently re-scope a review-queue verdict.
const SCAN_PLACE_FILLER_WORDS = new Set([
  ...STYLE_WORDS, ...STYLE_FILLER_WORDS, ...CONTAINMENT_HOUSE_WORDS,
  'wine', 'wines', 'wein', 'weine', 'vins', 'vini', 'vinho', 'vinhos',
  'organic', 'organico', 'bio', 'biologique', 'eco', 'natural', 'nature',
  'winery', 'wineries', 'cellar', 'cellars', 'estate', 'estates',
  'vineyard', 'vineyards', 'vignoble', 'vignobles', 'vigneron', 'vignerons',
  'selection', 'reserve', 'reserva', 'riserva', 'cuvee', 'collection',
  'grand', 'grande', 'premium', 'classic', 'original', 'old', 'vine', 'vines',
  'the', 'of', 'and', 'et', 'y', 'e', 'les', 'des', 'los', 'las', 'dos', 'das',
]);

/**
 * Producer = a known place + only filler? Pure given refs (the same preloaded
 * maps every detect() reads). Tries every contiguous token window, longest
 * first, so "Vino de la Tierra de Castilla Organic" finds the longest place
 * match before a shorter accidental one. Single-token producers are the exact
 * rules' turf (producer-is-appellation et al) and are skipped here.
 *
 * @returns {{ place: string, filler: string }|null}
 */
function detectPlacePlusFillerProducer(producer, refs) {
  const tokens = normalizeString(String(producer == null ? '' : producer).replace(/ß/g, 'ss'))
    .split(' ').filter(Boolean);
  if (tokens.length < 2) return null;
  for (let len = tokens.length - 1; len >= 1; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      const outside = [...tokens.slice(0, start), ...tokens.slice(start + len)];
      if (!outside.every(t => SCAN_PLACE_FILLER_WORDS.has(t))) continue;
      const windowStr = tokens.slice(start, start + len).join(' ');
      const place = lookupEntity(refs.appellations, windowStr)
        || lookupEntity(refs.regions, windowStr)
        || lookupEntity(refs.countries, windowStr);
      if (place) return { place, filler: outside.join(' ') || '(none)' };
    }
  }
  return null;
}

module.exports = {
  CROSS_FIELD_CHECKS, DB_BACKED_CROSS_FIELD_CHECKS, ALL_CROSS_FIELD_CHECKS,
  CROSS_FIELD_CHECK_IDS, DEFAULT_CROSS_FIELD_CHECK_IDS,
  IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS,
  CROSS_FIELD_CHECK_LABEL_KEYS, CROSS_FIELD_CHECK_FIELDS,
  CROSS_FIELD_CHECK_SELECT, resolveCrossFieldCheck, runCrossFieldChecks,
  buildCrossFieldRefs,
  detectPlacePlusFillerProducer, SCAN_SUSPECT_PLACE_FILLER_ID,
};
