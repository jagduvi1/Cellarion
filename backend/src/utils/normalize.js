// Normalization utilities for deduplication and fuzzy matching

const { RECOGNIZED_COUNTRY_NAMES } = require('../data/countryNames');

/**
 * Wine-domain stop words that don't add meaningful distinction
 * These are removed during tokenization for better matching
 */
const WINE_STOP_WORDS = new Set([
  'wine', 'wines', 'winery', 'vineyard', 'vineyards', 'estate', 'estates',
  'cellars', 'cellar', 'reserve', 'selection', 'cuvee', 'cuvée',
  'château', 'chateau', 'domaine', 'domain', 'bodega', 'casa',
  // House prefixes that labels include and databases omit (or vice versa) —
  // "Cantina Bartolo Mascarello" IS "Bartolo Mascarello". Stripping them on
  // the token axis lifts such pairs into the resolver's soft zone ("did you
  // mean?") instead of silently minting a duplicate registry wine (the
  // launch-day Barolo report). Comparison-only: display names keep prefixes.
  'cantina', 'cantine', 'azienda', 'agricola', 'tenuta', 'tenute',
  'cascina', 'fattoria', 'podere', 'poderi', 'vinicola',
  'weingut', 'bodegas', 'maison', 'vinos', 'vina', 'viña',
  'the', 'le', 'la', 'de', 'di', 'del', 'della', 'des', 'du',
  'and', 'et', 'y', 'e', 'und'
]);

/**
 * Normalize a string for comparison
 * - Convert to lowercase
 * - Remove accents/diacritics
 * - Remove punctuation
 * - Collapse whitespace
 */
const normalizeString = (str) => {
  if (!str) return '';

  return str
    .toLowerCase()
    .normalize('NFD') // Decompose accented characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
};

/** Longest a stored taxonomy display name may be. */
const MAX_TAXONOMY_NAME = 200;

/**
 * Bound a taxonomy DISPLAY name before it is stored.
 *
 * `normalizeString` already collapses whitespace for the lookup key, but the
 * display name is stored separately and was only ever `.trim()`ed \u2014 so a region
 * or grape could hold interior newlines and unbounded length. That matters twice
 * over: two names differing by a space are one thing to a human and two rows to
 * the registry, and these values are substituted into the enrichment prompt,
 * where a newline is how you make injected text look like a new instruction.
 *
 * Belongs here rather than beside any one caller: creation goes through
 * findOrCreateWine, but the admin taxonomy routes RENAME existing rows, and a
 * guard that only covers create is not a chokepoint (security audit 2026-08-03).
 */
const sanitizeTaxonomyName = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAXONOMY_NAME);
};

/**
 * Tokenize a string and remove wine-domain stop words
 * Used for more sophisticated matching
 */
const tokenize = (str) => {
  if (!str) return [];

  const normalized = normalizeString(str);
  const tokens = normalized.split(/\s+/).filter(token => {
    return token.length > 0 && !WINE_STOP_WORDS.has(token);
  });

  return tokens;
};

// Classification-tier suffixes some labels/imports append to an appellation and
// others omit, splitting one appellation into variants ("Barolo" vs "Barolo
// DOCG"). The tier belongs in the separate classification field, so the
// canonical appellation is the place name with a trailing tier stripped. Only
// unambiguous 2–4 char tiers — deliberately NOT 'do'/'ao' as TRAILING tokens,
// which collide with real place-name words ('do' is safe as a LEADING token,
// below). dop/doq/vqa/wo added per the 2026-07-26 registry audit (RC-4:
// "Ontario VQA", "Swartland WO", "Priorat DOQ", ~20 "… DOP" rows survived the
// old set). 'dac' stays out — "Kamptal DAC" is the official appellation form.
const APPELLATION_TIER_TOKENS = new Set(['docg', 'doca', 'doc', 'aoc', 'aop', 'ava', 'igt', 'igp', 'dop', 'doq', 'vqa', 'wo']);

// Tier tokens that may open an appellation ("DO Alicante", "DOCa Rioja",
// "D.O. Valle Central", "IGT Toscana") — the majority of the tier pollution
// the audit found was PREFIX-form, which the trailing loop can never see.
// Narrower than the trailing set on purpose: "VQA Ontario" and "Wine of
// Origin Western Cape" are the official forms of real appellations (audit
// leave-alone list), so 'vqa'/'wo' are trailing-only.
const APPELLATION_LEADING_TIER_TOKENS = new Set(['do', 'doca', 'docg', 'doc', 'aoc', 'aop', 'ava', 'igt', 'igp', 'dop', 'doq']);

// Strip trailing characters (any in `chars`) without a `$`-anchored quantifier
// regex — a plain scan, so it can never be a polynomial-ReDoS shape.
const trimTrailingChars = (str, chars) => {
  let end = str.length;
  while (end > 0 && chars.includes(str[end - 1])) end -= 1;
  return str.slice(0, end);
};

/**
 * Canonicalize an appellation by stripping a trailing classification tier
 * ("Barolo DOCG" → "Barolo", "Napa Valley AVA" → "Napa Valley"). Preserves the
 * casing/accents of the place part; never returns empty (falls back to the
 * trimmed original). Passes null/undefined through unchanged.
 *
 * Token-based + regex-free trailing strip, so it stays strictly linear.
 */
/**
 * The comparison KEY for appellation identity (strategy 2026-07-29 R2).
 *
 * normalizeString DELETES hyphens, so "Châteauneuf-du-Pape" folds to
 * 'chateauneufdupape' while the typed "Chateauneuf du Pape" folds to
 * 'chateauneuf du pape' — two keys for one place, found on the first
 * prod-data test of the appellation resolver. Hyphens become spaces FIRST so
 * both forms share one key. Appellation-specific on purpose: normalizedKey /
 * canonicalKey semantics must not change (unique index + 4k existing keys),
 * so this fold applies only where Appellation docs are matched.
 */
const normalizeAppellationKey = (appellation) =>
  normalizeString(String(appellation == null ? '' : appellation).replace(/-/g, ' '));

const normalizeAppellation = (appellation) => {
  if (appellation == null) return appellation;
  const original = String(appellation).trim();
  const parts = original.split(/\s+/);
  // Drop leading tier token(s) — dots tolerated so "D.O." matches 'do'.
  while (parts.length > 1) {
    const first = parts[0].replace(/[.,]/g, '').toLowerCase();
    if (!APPELLATION_LEADING_TIER_TOKENS.has(first)) break;
    parts.shift();
  }
  // Drop trailing tier token(s), tolerating a trailing dot/comma on each.
  while (parts.length > 1) {
    const last = trimTrailingChars(parts[parts.length - 1], '.,').toLowerCase();
    if (!APPELLATION_TIER_TOKENS.has(last)) break;
    parts.pop();
  }
  const result = trimTrailingChars(parts.join(' '), ' ,').trim();
  return result || original;
};

// A vintage year TRAILING a wine name — imports and label scans routinely
// append it ("Reserve Cabernet Sauvignon 2023"), but the registry is
// vintage-neutral by construction: the year lives on Bottle.vintage.
// TRAILING only, on purpose: leading years are brand names ("1924 Double
// Black", "19 Crimes"), and a mid-name year is part of a cuvée. The window is
// 1950–2049 so historic marks like "1865" (Viña San Pedro's brand) survive
// even at the tail. Optional parens absorb "(2019)".
const TRAILING_VINTAGE_RX = /[\s\-–—(]+(?:19[5-9]\d|20[0-4]\d)\)?$/;

/**
 * Strip trailing vintage-year token(s) from a wine name ("Rioja Reserva 2019"
 * → "Rioja Reserva"). Loops for the double-stamp case ("X 2019 2019"); never
 * returns empty — a name that IS just a year is left alone (junk, but honest
 * junk beats an empty required field). Non-strings pass through unchanged.
 */
const stripTrailingVintage = (name) => {
  if (typeof name !== 'string') return name;
  let n = name.trim();
  for (let next = n.replace(TRAILING_VINTAGE_RX, '').trim();
       next !== n;
       next = n.replace(TRAILING_VINTAGE_RX, '').trim()) {
    if (!next) break;
    n = next;
  }
  return n;
};

/**
 * Corporate / legal-form suffixes that vary between a wine label and a registry
 * entry for the SAME producer ("Kumeu River" vs "Kumeu River Wines Limited").
 * Distinct from WINE_STOP_WORDS (which also governs wine-NAME matching) — these
 * are producer-specific and stripped only when building a producer COMPARISON
 * key, never from a display string.
 */
const PRODUCER_CORP_SUFFIXES = new Set([
  'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc',
  'gmbh', 'ag', 'sa', 'sas', 'sarl', 'srl', 'spa', 'sl', 'bv', 'nv',
  'pty', 'co', 'company', 'corp', 'corporation', 'ab', 'oy', 'as', 'kg', 'kft',
]);

// Cross-gender and abbreviated Saint forms of one estate name must share a
// bucket token: "Caronne Sainte Gemme" / "Caronne Ste Gemme" were 3 spellings
// holding 5 registry records for one Haut-Médoc estate (support ticket
// d49fea22), invisible to normalization because 'ste' and 'sainte' are simply
// different tokens. The key is comparison-only and non-unique, so a rare false
// fold (a 'Ste' abbreviating Société) lands in the human-reviewed canonical-
// collisions queue — never an auto-merge.
const PRODUCER_SAINT_TOKENS = new Set(['st', 'ste', 'saint', 'sainte']);

// Fold one already-normalized token into producer-key token space. Exported for
// stripProducerKeyPrefix, which walks a wine name's display words against the
// key-token run and must fold each word exactly like the key itself was folded
// — otherwise a name-side "St"/"Ste" could never match the key's 'saint'.
const foldProducerToken = (token) => (PRODUCER_SAINT_TOKENS.has(token) ? 'saint' : token);

// A TRAILING year on a producer string is a founding date, never part of the
// legal producer name — "Grand Pappy's 1846" and "Grand Pappy's" are the same
// house (support ticket d49dfd38). 1000–2049: founding dates reach centuries
// further back than TRAILING_VINTAGE_RX's vintage window.
const PRODUCER_FOUNDING_YEAR_RX = /^(?:1[0-9]{3}|20[0-4][0-9])$/;

// "Est." / "Anno" / "Since" only mean "founded" with a year attached, so a
// marker is dropped only right after the year it introduced was stripped
// ("Grand Pappy's Est. 1846" → "Grand Pappy's"); a bare mid-name 'est'
// (French for east — "Domaine de l'Est") is untouched.
const PRODUCER_FOUNDING_MARKERS = new Set(['est', 'estd', 'estab', 'anno', 'since']);

/**
 * Normalize a producer to a comparison/bucketing key: drop wine stop words AND
 * corporate suffixes, so "Kumeu River Wines Limited" and "Kumeu River" collapse
 * to the same key ("kumeu river"); fold Saint-token variants to one bucket
 * token ("St Hallett" ≡ "Saint Hallett") and strip trailing founding year(s).
 * Comparison-only — never overwrites the stored display producer. Returns ''
 * for an all-stopword/empty producer (every caller has a raw-string fallback
 * or skips the empty bucket — see wineIdentity.producerSegment).
 */
const normalizeProducerKey = (producer) => {
  // The founding-year strip inspects the PRE-stop-word token sequence: after
  // tokenize() drops 'winery', the brand year in "1848 Winery" would LOOK
  // trailing. Position is judged on the raw string, where a LEADING year is a
  // brand name and only a genuinely trailing one is a founding date.
  const raw = normalizeString(producer).split(' ').filter(Boolean);
  while (raw.length > 0 && PRODUCER_FOUNDING_YEAR_RX.test(raw[raw.length - 1])) {
    raw.pop();
    if (raw.length > 0 && PRODUCER_FOUNDING_MARKERS.has(raw[raw.length - 1])) raw.pop();
  }
  // A stop/corp word can also TRAIL the founding year ("Grand Pappy's 1846
  // Winery", "… 1846 Ltd") and hide it from the literal-tail loop above —
  // which would split keys the pre-fold code unified ("X 1846" vs "X 1846
  // Winery"; audit 2026-08-10). Walk back over droppable tail tokens and
  // strip a year found behind them — but only when it is NOT the opening
  // token: a leading year is a brand name ("1848 Winery") whatever follows.
  const droppableTail = (t) => PRODUCER_CORP_SUFFIXES.has(t) || tokenize(t).length === 0;
  let end = raw.length - 1;
  while (end > 0 && droppableTail(raw[end])) end -= 1;
  while (end > 0 && PRODUCER_FOUNDING_YEAR_RX.test(raw[end])) {
    raw.splice(end, 1);
    end -= 1;
    if (end > 0 && PRODUCER_FOUNDING_MARKERS.has(raw[end])) { raw.splice(end, 1); end -= 1; }
  }
  return tokenize(raw.join(' '))
    .filter((t) => !PRODUCER_CORP_SUFFIXES.has(t))
    .map(foldProducerToken)
    .join(' ')
    .trim();
};

// The producer segment a PENDING (producerless) wine keys under. Built by
// STRING CONCATENATION, deliberately NOT through generateWineKey: normalizeString
// emits [a-z0-9 ] only — it strips '~' — so a segment containing '~' is one no
// real producer can ever produce, which is what makes the pending key namespace
// provably disjoint from the ordinary one under the UNIQUE normalizedKey index.
// The creator id in the segment is what stops two users' identical producerless
// adds from colliding, while making the SAME user's retry key identically and
// resolve to their own row instead of minting again.
//
// Lives here, beside generateWineKey, because BOTH the resolver
// (services/findOrCreateWine) and the curation queue (services/pendingWineOps)
// must agree on it — and normalize.js has no dependencies, so neither module
// has to drag the other's dependency tree (or mock it) to build a key.
// See the pendingIdentity field note on models/WineDefinition.js.
const PENDING_KEY_PREFIX = 'pending~';
const pendingProducerKey = (userId) => `${PENDING_KEY_PREFIX}${String(userId)}`;
const pendingWineKey = (name, userId, appellation = '') =>
  `${pendingProducerKey(userId)}:${normalizeString(name)}:${normalizeString(appellation)}`;

/**
 * Generate a normalized key for wine deduplication
 * Combines producer + wine name + appellation
 */
const generateWineKey = (name, producer, appellation = '') => {
  const normalizedName = normalizeString(name);
  const normalizedProducer = normalizeString(producer);
  const normalizedAppellation = normalizeString(appellation);

  // Combine in a consistent order
  return `${normalizedProducer}:${normalizedName}:${normalizedAppellation}`;
};

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy matching / similarity scoring.
 *
 * Uses two rolling rows (the shorter string as the inner dimension) so memory
 * is O(min(m, n)) rather than the O(m·n) full matrix — this keeps a pathological
 * input from allocating hundreds of MB even if length caps upstream were bypassed.
 */
const levenshteinDistance = (str1, str2) => {
  let m = str1.length;
  let n = str2.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Keep the shorter string as the column (inner) dimension.
  if (n > m) { [str1, str2] = [str2, str1]; [m, n] = [n, m]; }

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = Math.min(
          prev[j] + 1,       // deletion
          curr[j - 1] + 1,   // insertion
          prev[j - 1] + 1    // substitution
        );
      }
    }
    const tmp = prev; prev = curr; curr = tmp;
  }

  return prev[n];
};

// Strings longer than this are never a genuine fuzzy-duplicate of a wine
// name/producer; the route and schema already cap input length, so this is
// defense-in-depth bounding the O(m·n) edit-distance cost.
const MAX_COMPARE_LEN = 256;

/**
 * Calculate similarity score between two strings (0-1)
 * 1 = identical, 0 = completely different
 */
const calculateSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  let normalized1 = normalizeString(str1);
  let normalized2 = normalizeString(str2);

  if (normalized1 === normalized2) return 1;

  if (normalized1.length > MAX_COMPARE_LEN) normalized1 = normalized1.slice(0, MAX_COMPARE_LEN);
  if (normalized2.length > MAX_COMPARE_LEN) normalized2 = normalized2.slice(0, MAX_COMPARE_LEN);

  const maxLength = Math.max(normalized1.length, normalized2.length);
  if (maxLength === 0) return 1;

  const distance = levenshteinDistance(normalized1, normalized2);
  return 1 - distance / maxLength;
};

/**
 * Generate trigrams from a string for fuzzy matching
 * e.g., "wine" -> ["  w", " wi", "win", "ine", "ne "]
 */
const generateTrigrams = (str) => {
  if (!str) return new Set();

  const normalized = normalizeString(str);
  const padded = `  ${normalized} `; // Pad for boundary trigrams
  const trigrams = new Set();

  for (let i = 0; i < padded.length - 2; i++) {
    trigrams.add(padded.substring(i, i + 3));
  }

  return trigrams;
};

/**
 * Calculate trigram similarity between two strings (Jaccard index)
 * Returns 0-1, where 1 = identical, 0 = no common trigrams
 */
const trigramSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  const trigrams1 = generateTrigrams(str1);
  const trigrams2 = generateTrigrams(str2);

  if (trigrams1.size === 0 && trigrams2.size === 0) return 1;
  if (trigrams1.size === 0 || trigrams2.size === 0) return 0;

  // Calculate intersection
  const intersection = new Set([...trigrams1].filter(t => trigrams2.has(t)));

  // Jaccard index: intersection / union
  const union = trigrams1.size + trigrams2.size - intersection.size;
  return intersection.size / union;
};

/**
 * Token-based similarity (Jaccard index on tokens)
 * Good for matching phrases with different word order
 */
const tokenSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  const tokens1 = new Set(tokenize(str1));
  const tokens2 = new Set(tokenize(str2));

  if (tokens1.size === 0 && tokens2.size === 0) return 1;
  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
  const union = tokens1.size + tokens2.size - intersection.size;

  return intersection.size / union;
};

/**
 * Combined similarity score using multiple algorithms
 * Weights: Levenshtein (40%), Trigram (30%), Token (30%)
 */
const combinedSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;

  const levSim = calculateSimilarity(str1, str2);
  const triSim = trigramSimilarity(str1, str2);
  const tokSim = tokenSimilarity(str1, str2);

  // Weighted combination
  return levSim * 0.4 + triSim * 0.3 + tokSim * 0.3;
};

/**
 * Map of alternate/regional grape names → canonical English name.
 * Keys are the output of normalizeString() applied to the alternate name.
 * Values are the canonical display name to store in the database.
 *
 * This prevents the same physical grape from being stored as multiple Grape
 * records when different labels (or the AI) use regional synonyms.
 */
const GRAPE_SYNONYMS = {
  // Syrah / Shiraz
  'shiraz':               'Syrah',

  // Grenache family
  'garnacha':             'Grenache',
  'garnacha tinta':       'Grenache',
  'grenache noir':        'Grenache',
  'grenache blanc':       'Grenache Blanc',
  'garnacha blanca':      'Grenache Blanc',
  'grenache gris':        'Grenache Gris',

  // Malbec / Côt
  // NOTE: 'auxerrois' is deliberately NOT mapped. It is a Malbec synonym only
  // in Cahors; in Alsace/Lorraine (where the name is far more common on
  // labels) Auxerrois is a distinct white grape — the mapping silently
  // corrupted every Alsace Auxerrois auto-created via label scan / AI import.
  'cot':                  'Malbec',
  'cote':                 'Malbec',
  'malbeck':              'Malbec',

  // Tempranillo synonyms
  'tinto fino':           'Tempranillo',
  'tinta del pais':       'Tempranillo',
  'tinta de toro':        'Tempranillo',
  'aragonez':             'Tempranillo',
  'ull de llebre':        'Tempranillo',
  'cencibel':             'Tempranillo',

  // Pinot Gris / Pinot Grigio
  'pinot grigio':         'Pinot Gris',
  'grauburgunder':        'Pinot Gris',
  'rulander':             'Pinot Gris',

  // Pinot Noir synonyms
  'spatburgunder':        'Pinot Noir',
  'blauburgunder':        'Pinot Noir',
  'clevner':              'Pinot Noir',

  // Pinot Blanc synonyms
  'pinot bianco':         'Pinot Blanc',
  'weissburgunder':       'Pinot Blanc',

  // Sangiovese synonyms
  'brunello':             'Sangiovese',
  'prugnolo gentile':     'Sangiovese',
  'morellino':            'Sangiovese',
  'sangiovese grosso':    'Sangiovese', // Montalcino's local name — 15 Brunelli on prod carried it as a separate grape

  // Zinfandel / Primitivo — same DNA, often listed interchangeably
  'primitivo':            'Zinfandel',

  // Carignan
  'carignane':            'Carignan',
  'carinan':              'Carignan',
  'mazuelo':              'Carignan',
  'samso':                'Carignan',

  // Mourvèdre
  'monastrell':           'Mourvèdre',
  'mataro':               'Mourvèdre',
  'mourvedre':            'Mourvèdre',

  // Albariño
  'alvarinho':            'Albariño',
  'albarino':             'Albariño',

  // Sauvignon Blanc — AI occasionally truncates
  'sauvignon':            'Sauvignon Blanc',

  // Chardonnay has no real synonyms but handle Morillon (Austria)
  'morillon':             'Chardonnay',

  // Muscadet (the wine name used as grape name by mistake)
  'muscadet':             'Melon de Bourgogne',

  // Spelling variants / typos / short forms that existed as duplicate Grape
  // docs on prod (merged 2026-07-11) — mapped so they can't come back.
  'agiorghitiko':         'Agiorgitiko',
  'inzolia':              'Insolia',
  'corvina veronese':     'Corvina',
  'cesanese di affile':   "Cesanese d'Affile",
  'sylvaner':             'Silvaner',
  'tinta barocca':        'Tinta Barroca',
  'tintaroriz':           'Tinta Roriz',   // "Tinta-Roriz" — hyphens are deleted by normalizeString
  'verdehlo':             'Verdelho',
  'bacchud':              'Bacchus',
  'vidal':                'Vidal Blanc',
  'foch':                 'Maréchal Foch',
  'portugieser':          'Blauer Portugieser',

  // ß is stripped (not expanded to ss) by normalizeString, so the existing
  // 'weissburgunder' key never matched the actual label spelling Weißburgunder
  // — a duplicate Grape doc proved it on prod.
  'weiburgunder':         'Pinot Blanc',
  'weisser burgunder':    'Pinot Blanc',
};

/**
 * Resolve a grape name to its canonical English form.
 * If the name (after normalization) matches a known synonym, the canonical
 * name is returned. Otherwise the original trimmed name is returned unchanged.
 *
 * @param {string} name  Raw grape name from label scan or user input
 * @returns {string}     Canonical grape name for storage
 */
const resolveGrapeName = (name) => {
  if (!name || !name.trim()) return name;
  // Blend percentages are not part of a variety name — the AI occasionally
  // returns "70% Monastrell" / "Monastrell 70%" verbatim from a back label,
  // which minted grape documents named "70% Monastrell" on prod. Strip the
  // percentage and resolve what remains ("70%" alone → '' → caller drops it).
  // Whitespace runs are BOUNDED, not `\s*` (CodeQL js/polynomial-redos, alert
  // #199 open since 2026-07-18). With `\s*` the trailing pattern is retried at
  // every index of a long run of spaces, each attempt rescanning the run — a
  // quadratic walk on an attacker-supplied grape name, and grape names arrive
  // from label scan, import files and the AI. A real percentage carries at most
  // one space on either side, so {0,3} changes no legitimate input.
  const stripped = name.trim()
    .replace(/^\d{1,3}\s{0,3}%\s{0,3}/, '')
    .replace(/\s{0,3}\d{1,3}\s{0,3}%$/, '');
  const key = normalizeString(stripped);
  return GRAPE_SYNONYMS[key] || stripped;
};

/**
 * Map of alternate country names → canonical English name.
 * Keys are the output of normalizeString() applied to the alternate name.
 * Values are the canonical Country.name used by the seeded taxonomy.
 *
 * Same idea as GRAPE_SYNONYMS: the AI importer and label scan receive labels
 * in the user's language ("Tyskland", "Italie") or informal abbreviations
 * ("USA"), and findOrCreateCountry would otherwise mint a duplicate Country
 * document for each spelling — this happened on prod (USA / United States Of
 * America / Tyskland / Italie / New Zeeland were all created as countries).
 * Covers Swedish, German, French, Spanish, Italian and Dutch names for the
 * wine countries plus common English variants; anything unmapped passes
 * through unchanged and still dedupes by normalizedName.
 */
const COUNTRY_ALIASES = {
  // United States
  'usa':                      'United States',
  'us':                       'United States',
  'united states of america': 'United States',
  'america':                  'United States',
  'estados unidos':           'United States',
  'etatsunis':                'United States', // États-Unis (hyphen deleted by normalizeString)
  'vereinigte staaten':       'United States',

  // England — canonical wine country (English PDO sparkling/still wines;
  // wine-world convention over ISO). Welsh wines are rare enough that a
  // separate "Wales" country may still be created deliberately.
  'united kingdom':           'England',
  'uk':                       'England',
  'great britain':            'England',
  'storbritannien':           'England',
  'grobritannien':            'England', // Großbritannien (ß is stripped by normalizeString)

  // Germany
  'tyskland':                 'Germany',   // sv/da/no
  'deutschland':              'Germany',
  'allemagne':                'Germany',
  'alemania':                 'Germany',
  'germania':                 'Germany',
  'duitsland':                'Germany',

  // Italy
  'italie':                   'Italy',     // fr
  'italia':                   'Italy',
  'italien':                  'Italy',     // sv + de

  // France
  'frankrike':                'France',    // sv
  'frankreich':               'France',
  'francia':                  'France',
  'frankrijk':                'France',

  // Spain
  'spanien':                  'Spain',     // sv + de
  'espagne':                  'Spain',
  'espana':                   'Spain',
  'espanha':                  'Spain',
  'spagna':                   'Spain',
  'spanje':                   'Spain',

  // Portugal — same spelling in most languages; no aliases needed

  // New Zealand
  'new zeeland':              'New Zealand', // common typo (created a prod country)
  'nya zeeland':              'New Zealand', // sv
  'neuseeland':               'New Zealand',
  'nouvellezelande':          'New Zealand', // Nouvelle-Zélande (hyphen deleted)
  'nueva zelanda':            'New Zealand',
  'nuova zelanda':            'New Zealand',

  // Austria
  'osterrike':                'Austria',   // sv (Österrike)
  'osterreich':               'Austria',   // de (Österreich)
  'autriche':                 'Austria',

  // South Africa
  'sydafrika':                'South Africa', // sv
  'sudafrika':                'South Africa', // de (Südafrika)
  'afrique du sud':           'South Africa',
  'sudafrica':                'South Africa',

  // Australia
  'australien':               'Australia', // sv + de
  'australie':                'Australia',

  // Greece
  'grekland':                 'Greece',    // sv
  'griechenland':             'Greece',
  'grece':                    'Greece',
  'grecia':                   'Greece',

  // Hungary
  'ungern':                   'Hungary',   // sv
  'ungarn':                   'Hungary',
  'hongrie':                  'Hungary',
  'ungheria':                 'Hungary',

  // Switzerland
  'schweiz':                  'Switzerland', // sv + de
  'suisse':                   'Switzerland',
  'svizzera':                 'Switzerland',

  // Croatia
  'kroatien':                 'Croatia',   // sv + de
  'croatie':                  'Croatia',
  'croazia':                  'Croatia',
  'hrvatska':                 'Croatia',

  // Czech Republic
  'czechia':                  'Czech Republic',
  'tjeckien':                 'Czech Republic', // sv
  'tschechien':               'Czech Republic',

  // Netherlands
  'holland':                  'Netherlands',
  'nederlanderna':            'Netherlands', // sv
  'niederlande':              'Netherlands',
  'paysbas':                  'Netherlands', // Pays-Bas (hyphen deleted)

  // Georgia
  'georgien':                 'Georgia',   // sv + de
  'georgie':                  'Georgia',

  // Lebanon
  'libanon':                  'Lebanon',   // sv + de
  'liban':                    'Lebanon',

  // Turkey
  'turkiye':                  'Turkey',
  'turkiet':                  'Turkey',    // sv
  'turkei':                   'Turkey',    // de (Türkei)
  'turquie':                  'Turkey',

  // Belgium
  'belgien':                  'Belgium',   // sv + de
  'belgique':                 'Belgium',
  'belgie':                   'Belgium',

  // Scandinavia
  'sverige':                  'Sweden',
  'schweden':                 'Sweden',
  'suede':                    'Sweden',
  'norge':                    'Norway',
  'norwegen':                 'Norway',
  'norvege':                  'Norway',
  'danmark':                  'Denmark',
  'danemark':                 'Denmark',

  // Canada / Mexico / Brazil / Japan / Morocco
  'kanada':                   'Canada',    // sv + de
  'mexiko':                   'Mexico',    // sv + de
  'mexique':                  'Mexico',
  'brasilien':                'Brazil',    // sv + de
  'bresil':                   'Brazil',
  'brasil':                   'Brazil',
  'japon':                    'Japan',
  'marocko':                  'Morocco',   // sv
  'marokko':                  'Morocco',   // de
  'maroc':                    'Morocco',

  // Eastern Europe
  'slovenien':                'Slovenia',  // sv
  'slowenien':                'Slovenia',  // de
  'rumanien':                 'Romania',   // sv/de (Rumänien)
  'roumanie':                 'Romania',
  'bulgarien':                'Bulgaria',  // sv + de
  'bulgarie':                 'Bulgaria',
  'moldavien':                'Moldova',   // sv
  'moldawien':                'Moldova',   // de
  'russia':                   'Russian Federation',
  'ryssland':                 'Russian Federation', // sv

  // South America
  'argentine':                'Argentina', // fr
  'argentinien':              'Argentina', // de
  'chili':                    'Chile',     // fr + nl
};

/**
 * Resolve a country name to its canonical English form.
 * If the name (after normalization) matches a known alias, the canonical
 * name is returned. Otherwise the original trimmed name is returned unchanged.
 *
 * @param {string} name  Raw country name from label scan, AI lookup or import
 * @returns {string}     Canonical country name for storage
 */
const resolveCountryName = (name) => {
  if (!name || !name.trim()) return name;
  const key = normalizeString(name);
  return COUNTRY_ALIASES[key] || name.trim();
};

// Built once at load; both sides go through normalizeString so case,
// diacritics and punctuation can never cause a false rejection.
const RECOGNIZED_COUNTRY_SET = new Set(RECOGNIZED_COUNTRY_NAMES.map(normalizeString));

/**
 * Is this a real country (after alias resolution)? The mint gate for
 * findOrCreateCountry: "Espalda" / "Back label" / a hallucinated string must
 * never become a Country document, while a real country that just isn't in
 * the taxonomy yet (India, Thailand) may still be created legitimately.
 * See data/countryNames.js for what "recognized" means.
 *
 * @param {string} name  Raw country name from label scan, AI lookup or import
 * @returns {boolean}
 */
const isRecognizedCountry = (name) => {
  if (!name || !name.trim()) return false;
  return RECOGNIZED_COUNTRY_SET.has(normalizeString(resolveCountryName(name)));
};

/**
 * Placeholder values the AI (or an import file) uses when it doesn't actually
 * know the value — despite the prompts demanding null. The registry's
 * representation for unknown is country/region = null and grapes = [] — never
 * a taxonomy document literally named "Unknown" (prod accumulated an Unknown
 * country, five Unknown regions and an "unknown" grape this way).
 * Keys are checked after normalizeString(), so "Okänd" → "okand", "N/A" → "na",
 * "?" / "-" → "" (caught by the empty check).
 */
const UNKNOWN_NAME_RX = /^(unknown|unbekannt|okand|ukjent|inconnu|inconnue|sconosciuto|desconocido|na|none|null|nil|various|misc|miscellaneous|not specified|unspecified|not available|tbd|to be determined)$/;

const isUnknownName = (name) => {
  if (!name || !name.trim()) return true;
  const key = normalizeString(name);
  return key === '' || UNKNOWN_NAME_RX.test(key);
};

/**
 * Producer/name placeholders a user (or an import file, or a label the AI could
 * not read) puts in the box when they simply do not know — "Unknown", "N/A",
 * "-", "Domaine Unknown". They must never be STORED as a producer: every one of
 * them would become a shared-registry producer other people's wines then match
 * against (prod grew a producer literally named "Unknown" this way).
 *
 * Checked after normalizeString(), which lowercases, strips diacritics and
 * drops punctuation — so "N/A" → "na", "Okänd" → "okand", and "-" / "?" → ""
 * (caught by the empty check). Deliberately a SUPERSET of UNKNOWN_NAME_RX
 * above: that one guards taxonomy minting, this one guards the wine's own
 * identity fields and adds the two-word producer forms ("no producer").
 */
const IDENTITY_SENTINEL_RX =
  /^(unknown|unbekannt|inconnu|inconnue|okand|na|none|no producer|producer unknown|domaine unknown|unknown producer|unknown winery)$/;

/**
 * Letters or digits that survive diacritic folding but that `normalizeString`
 * cannot represent — i.e. a script outside its `[a-z0-9 ]` output. "Ø" and "é"
 * fold to ASCII and are NOT counted; Cyrillic, Greek, Georgian, Han, Kana,
 * Hebrew, Arabic and Devanagari are.
 *
 * The point: normalizeString returning '' is only evidence of "no information"
 * for a Latin-script value. For "Мукузани" the empty key is a limit of the KEY,
 * not a statement about the producer.
 */
const hasNonLatinAlnum = (str) =>
  /[\p{L}\p{N}]/u.test(
    str.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // fold diacritics first — "Château" is Latin
      .replace(/[\u0000-\u007f]/g, '')  // drop everything normalizeString can see
  );

/**
 * True when an identity string carries no real information — empty, whitespace,
 * punctuation-only, or one of the sentinels above. Used by the pending-identity
 * mint path (services/findOrCreateWine) to decide "this producer is MISSING,
 * not wrong", and by the WineDefinition auto-promote hook to decide when a
 * pending row has become a complete identity.
 *
 * UNICODE-AWARE, and it has to be (security audit): normalizeString strips
 * every non-ASCII letter, so "Мукузани", "ქართული ღვინო", "獺祭" and "Δομαίν"
 * all normalized to '' and read as MISSING. That discarded the producer the
 * user actually typed at mint time and — worse — made the row unpromotable,
 * because a curator typing the producer exactly as printed on the label hit
 * this same predicate in the auto-promote hook and the wine stayed hidden
 * forever. Any letter or number in ANY script is real information.
 */
const isIdentitySentinel = (value) => {
  if (typeof value !== 'string') return true;
  // Checked BEFORE the fold, so a mixed value ("Unknown Мукузани") is judged on
  // what it contains rather than on the Latin fragment that survives.
  if (hasNonLatinAlnum(value)) return false;
  const key = normalizeString(value);
  return key === '' || IDENTITY_SENTINEL_RX.test(key);
};

/**
 * Is this producer+name pair IMPLAUSIBLY SHAPED — i.e. present, non-sentinel,
 * and still not a usable identity?
 *
 * The gap this closes (found in prod): a wine minted with producer "Increíble"
 * AND name "Increíble" — the label's one readable word echoed into both boxes
 * by the scan — passed `isIdentitySentinel` on both fields, so the auto-promote
 * hook let it leave the pending queue. It reached the maturity queue as a
 * public registry row, and by then its label photo was no longer reachable:
 * the one piece of evidence that could have fixed it was gated on the row still
 * being pending. "Non-empty" is not the same as "an identity".
 *
 * CONTRACT — synchronous, pure and DEPENDENCY-FREE, because its primary caller
 * is the WineDefinition pre-validate hook, which must not do DB I/O. Everything
 * here is a string-shape test. The taxonomy-dependent half of the same question
 * ("is this producer actually a place / a grape?") cannot be answered without
 * the DB and therefore lives elsewhere: the mint gate in
 * services/findOrCreateWine and the cross-field rules in utils/crossFieldChecks,
 * enforced on the curation write path (services/pendingWineOps.applyPendingFix).
 *
 * Lives beside isIdentitySentinel so mint, promotion and curation share ONE
 * definition of "this identity is not usable yet".
 *
 * What it deliberately does NOT catch — each would need either the DB or a
 * judgement this predicate has no basis for:
 *   • a producer that is a real PLACE or GRAPE ("Chablis", "Tokaji", "Syrah") —
 *     taxonomy lookups, see above;
 *   • a producer wholly contained in the name that still leaves a distinct
 *     remainder ("Cloudy Bay" / "Cloudy Bay Sauvignon Blanc") — a formatting
 *     defect, not a missing identity, and refusing it would trap a wine a
 *     curator transcribed correctly off the label;
 *   • a well-shaped producer that is simply WRONG (a range name, a retailer, a
 *     misread cuvée) — nothing in the string says so;
 *   • anything about appellation / region / country / grapes;
 *   • NON-LATIN identities. normalizeString cannot see them, so every fold
 *     below would read "empty" and condemn a real producer — the exact H-4
 *     regression that made "Мукузани" rows unpromotable. Judged plausible and
 *     left to the curator.
 *
 * @param {string} producer
 * @param {string} name
 * @returns {boolean} true when the pair must NOT be promoted / minted public
 */
const isImplausibleIdentity = (producer, name) => {
  if (typeof producer !== 'string' || typeof name !== 'string') return false;
  // See the non-Latin note above — this predicate has no opinion on scripts
  // normalizeString cannot represent.
  if (hasNonLatinAlnum(producer) || hasNonLatinAlnum(name)) return false;

  const p = normalizeString(producer);
  const n = normalizeString(name);
  // MISSING is isIdentitySentinel's verdict, not this one's. Returning false
  // here keeps the two predicates strictly complementary: callers ask both.
  if (!p || !n) return false;

  // 1. The live bug: the name echoed into the producer field.
  if (p === n) return true;
  // 2. A one-character producer is a stray keystroke — same bar the mint gate
  //    has always applied (findOrCreateWine's producerNorm.length < 2).
  if (p.length < 2) return true;
  // 3. Digits only ("2019", "12345"). Punctuation-only folds to '' and was
  //    already isIdentitySentinel's business.
  if (!/[a-z]/.test(p)) return true;

  // 4. Containment leaving NO DISTINCT PRODUCER. Compared on stop-word-stripped
  //    tokens, because that is what "distinct" means here: producer "Increíble
  //    Wines" with name "Increíble" is the same echo as case 1 wearing an estate
  //    word, while "Cloudy Bay" with name "Cloudy Bay Sauvignon Blanc" leaves
  //    'sauvignon blanc' and is a real (if badly formatted) identity.
  const producerTokens = tokenize(producer);
  const nameTokens = tokenize(name);
  // A producer that is nothing but house/stop words ("Domaine", "Cantina") —
  // branding with no house attached to it.
  if (producerTokens.length === 0) return true;
  const producerSet = new Set(producerTokens);
  const nameSet = new Set(nameTokens);
  const producerOnly = producerTokens.filter((t) => !nameSet.has(t));
  const nameOnly = nameTokens.filter((t) => !producerSet.has(t));
  return producerOnly.length === 0 && nameOnly.length === 0;
};

/**
 * Grape names additionally reject descriptions-instead-of-varietals: the AI
 * sometimes returns hedges like "blend - specific varieties unknown",
 * "unknown - likely Riesling, Gewurztraminer, Pinot Gris, or Muscat" or
 * "blend of 40 botanicals including orange peel" (all real prod examples).
 * A blend's correct representation is the list of its varieties, or [].
 */
const JUNK_GRAPE_RX = /\bblends?\b|\bbotanicals?\b|\blikely\b|\bunknown\b|\bvarieties\b|\bunspecified\b/i;

const isJunkGrapeName = (name) => isUnknownName(name) || JUNK_GRAPE_RX.test(name);

/**
 * Convert any string to a URL-safe slug (lowercase, hyphenated, ASCII-only).
 * Builds on normalizeString (which already strips diacritics and punctuation).
 */
const slugify = (str) => {
  if (!str) return '';
  return normalizeString(str)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
};

/**
 * Build a vintage-neutral slug for a WineDefinition. If the wine name already
 * starts with the producer name, we don't duplicate the producer ("Cloudy Bay
 * Sauvignon Blanc" produced by "Cloudy Bay" → "cloudy-bay-sauvignon-blanc",
 * not "cloudy-bay-cloudy-bay-sauvignon-blanc").
 */
const generateWineSlug = (name, producer) => {
  const nName = normalizeString(name);
  const nProducer = normalizeString(producer);
  if (!nName) return slugify(producer);
  if (!nProducer || nName === nProducer || nName.startsWith(nProducer + ' ')) {
    return slugify(name);
  }
  return slugify(`${producer} ${name}`);
};


module.exports = {
  normalizeString,
  sanitizeTaxonomyName,
  MAX_TAXONOMY_NAME,
  slugify,
  tokenize,
  generateWineKey,
  PENDING_KEY_PREFIX,
  pendingProducerKey,
  pendingWineKey,
  generateWineSlug,
  GRAPE_SYNONYMS,
  normalizeProducerKey,
  foldProducerToken,
  normalizeAppellation,
  normalizeAppellationKey,
  stripTrailingVintage,
  resolveGrapeName,
  resolveCountryName,
  isRecognizedCountry,
  isUnknownName,
  isIdentitySentinel,
  isImplausibleIdentity,
  isJunkGrapeName,
  levenshteinDistance,
  calculateSimilarity,
  generateTrigrams,
  trigramSimilarity,
  tokenSimilarity,
  combinedSimilarity
};
