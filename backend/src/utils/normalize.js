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

// A star grade is part of a wine's NAME: Markus Molitor prints one to three
// stars after the Pr\u00e4dikat ("Auslese*", "Auslese**", "Auslese***"), and each
// grade is a separately bottled, separately priced wine. Stripped with the
// rest of the punctuation, the grades vanished: two of them shared one dedup
// key (the second could not be added at all) and the matcher read them as the
// same wine.
//
// Names only. normalizeString serves every field, and a star means nothing in
// a grape, a region, a country or a producer: there "Riesling*" must still be
// Riesling, and a bare "*" must still read as empty (a placeholder), so those
// keep stripping stars.
//
// A run of one to MAX_STAR_GRADE stars ('*' or '\u2605', spaces between them
// allowed) becomes a word: "Auslese***" \u2192 "Auslese 3star ". A longer run is
// decoration and goes with the punctuation; a value that is nothing but stars
// is a placeholder, not a grade, and is left for normalizeString to empty.
const MAX_STAR_GRADE = 5;
const STAR_RUN = /[*\u2605](?:\s*[*\u2605])*/g;
const spellStarGrades = (str) => {
  if (!str) return '';
  const s = String(str);
  if (!/[\p{L}\p{N}]/u.test(s.replace(STAR_RUN, ''))) return s;
  return s.replace(STAR_RUN, (run) => {
    const n = run.replace(/\s/g, '').length;
    return n <= MAX_STAR_GRADE ? ` ${n}star ` : ' ';
  });
};

/** normalizeString for a wine NAME: a star grade survives as a word. */
const normalizeWineName = (str) => normalizeString(spellStarGrades(str));

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
 * guard that only covers create is not a chokepoint.
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
// below). dop/doq/vqa/wo cover forms like "Ontario VQA", "Swartland WO",
// "Priorat DOQ" and "… DOP". 'dac' stays out — "Kamptal DAC" is the official
// appellation form.
// pdo/pgi: "Samos PDO" must match a curated "Samos" — the English EU marks
// are pure tier text on either side.
const APPELLATION_TIER_TOKENS = new Set(['docg', 'doca', 'doc', 'aoc', 'aop', 'ava', 'igt', 'igp', 'dop', 'doq', 'vqa', 'wo', 'pdo', 'pgi']);

// Tier tokens that may open an appellation ("DO Alicante", "DOCa Rioja",
// "D.O. Valle Central", "IGT Toscana") — most tier pollution is PREFIX-form,
// which the trailing loop can never see.
// Narrower than the trailing set on purpose: "VQA Ontario" and "Wine of
// Origin Western Cape" are the official forms of real appellations, so
// 'vqa'/'wo' are trailing-only.
const APPELLATION_LEADING_TIER_TOKENS = new Set(['do', 'doca', 'docg', 'doc', 'aoc', 'aop', 'ava', 'igt', 'igp', 'dop', 'doq', 'pdo', 'pgi']);

// Spelled-out tier PHRASES ("Denominación de Origen Valencia", "Chianti
// Denominazione di Origine Controllata") — multi-token, so the single-token
// loops below can never see them. Compared accent- and
// punctuation-folded (so "Denominació d'Origen" probes as
// ['denominacio','dorigen']), but only the DECORATION is dropped — the
// surviving name keeps its typed spelling, exactly like the token loops.
// Within a family, longest first, so "… de Origen Calificada" wins over its
// "… de Origen" prefix. These phrases are pure tier text in every language
// they appear in and none BEGINS a real appellation name, which is what makes
// a blind strip safe here while the ambiguous forms (trailing 'do', the
// name-wrapping "Appellation … Contrôlée") stay membership-gated in
// services/appellationResolve.
const APPELLATION_TIER_PHRASES = [
  ['denominacion', 'de', 'origen', 'calificada'],
  ['denominacion', 'de', 'origen', 'protegida'],
  ['denominacion', 'de', 'origen'],
  ['denominacio', 'dorigen', 'qualificada'],
  ['denominacio', 'dorigen', 'protegida'],
  ['denominacio', 'dorigen'],
  ['denominacao', 'de', 'origem', 'controlada'],
  ['denominacao', 'de', 'origem', 'protegida'],
  ['denominacao', 'de', 'origem'],
  ['denominazione', 'di', 'origine', 'controllata', 'e', 'garantita'],
  ['denominazione', 'di', 'origine', 'controllata'],
  ['denominazione', 'di', 'origine', 'protetta'],
  // The apostrophe spelling labels also print ("Denominazione d'Origine
  // Controllata"): "d'Origine" folds to one token.
  ['denominazione', 'dorigine', 'controllata', 'e', 'garantita'],
  ['denominazione', 'dorigine', 'controllata'],
  ['denominazione', 'dorigine', 'protetta'],
  // The bare French mark with no place in it ("Appellation Contrôlée" on an
  // old Burgundy label). The place-wrapping form stays membership-gated in
  // services/appellationResolve; see also isWrappedMarkLine.
  ['appellation', 'controlee'],
  ['appellation', 'protegee'],
  ['indicazione', 'geografica', 'tipica'],
  ['indicacion', 'geografica', 'protegida'],
  ['indication', 'geographique', 'protegee'],
  ['protected', 'designation', 'of', 'origin'],
  ['protected', 'geographical', 'indication'],
];

// Fold ONE display token to the shape the phrase table is written in:
// punctuation out ("d'Origen" → "dOrigen"), lowercased, accents stripped
// ("Denominación" → "denominacion", "Denominação" → "denominacao").
const foldTierWord = (token) => token
  .replace(/[.,'’()[\]]/g, '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '');

// Strip regulatory tier text off both ENDS of a token list: spelled-out
// phrases first, repeating until stable ("PDO Denominación de Origen X" is
// unrealistic but costs nothing to handle), then single tokens (the leading
// set, then the trailing set), then separator debris a strip leaves dangling
// ("Vin du Québec -"). Dots, commas and brackets fold
// OUT of a token before it probes a set, so the forms labels print — "Lison
// Classico D.O.C.G.", "Rioja D.O.Ca.", "Barolo (DOCG)" — match; the
// split is on whitespace, so folding cannot merge two tokens. `min` is the
// smallest list the loops may leave behind: 1 for an appellation (an input
// that IS only tier text survives untouched and the caller falls back to the
// original), 0 for a classification (a value that is only tier text is no
// classification at all). Mutates and returns `parts`.
const stripTierEdges = (parts, { min, phrases, leading, trailing }) => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of phrases) {
      if (parts.length >= phrase.length + min && phrase.every((w, i) => foldTierWord(parts[i]) === w)) {
        parts.splice(0, phrase.length);
        changed = true;
      }
      if (parts.length >= phrase.length + min &&
          phrase.every((w, i) => foldTierWord(parts[parts.length - phrase.length + i]) === w)) {
        parts.splice(parts.length - phrase.length, phrase.length);
        changed = true;
      }
    }
  }
  const fold = (token) => token.replace(/[.,()[\]]/g, '').toLowerCase();
  while (parts.length > min && leading.has(fold(parts[0]))) parts.shift();
  while (parts.length > min && trailing.has(fold(parts[parts.length - 1]))) parts.pop();
  while (parts.length > min && /^[-–—·|/]+$/.test(parts[0])) parts.shift();
  while (parts.length > min && /^[-–—·|/]+$/.test(parts[parts.length - 1])) parts.pop();
  return parts;
};

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
  const parts = stripTierEdges(original.split(/\s+/), {
    min: 1, phrases: APPELLATION_TIER_PHRASES,
    leading: APPELLATION_LEADING_TIER_TOKENS, trailing: APPELLATION_TIER_TOKENS,
  });
  const result = trimTrailingChars(parts.join(' '), ' ,').trim();
  return result || original;
};

// A production METHOD is not an appellation (GitHub discussion #1696):
// "Méthode Traditionnelle", "Metodo Classico", "Méthode Cap Classique" say how
// the bubbles were made, not where the wine is from — yet they turn up in the
// appellation field. Only a value that is NOTHING BUT a
// method counts. The same words also end real names ("Oltrepò Pavese Metodo
// Classico" is a DOCG, "Blanquette méthode ancestrale" an AOC), so an edge
// strip would turn one appellation into another; a value with a place in it
// is left for a curator. Compared folded, like the tier phrases above.
const PRODUCTION_METHOD_VALUES = new Set([
  'methode cap classique', 'cap classique', 'mcc',
  'methode traditionnelle', 'methode traditionelle', 'methode champenoise', 'methode classique',
  'metodo classico', 'metodo tradizionale', 'metodo tradicional', 'traditional method',
  'traditionelle flaschengarung', 'klassische flaschengarung', 'flaschengarung',
]);

/** True when the value is a production method and nothing else: it is then no appellation. */
const isProductionMethodOnly = (value) =>
  typeof value === 'string' &&
  PRODUCTION_METHOD_VALUES.has(value.trim().split(/\s+/).map(foldTierWord).join(' '));

// Spelled-out marks that reach the CLASSIFICATION field as a value in their
// own right ("Appellation d'Origine Protégée" filed as the tier of a Rhône
// wine). Kept off the appellation list on purpose: there "Appellation …
// Contrôlée" wraps a real place name and stays membership-gated in
// services/appellationResolve.
const CLASSIFICATION_TIER_PHRASES = [
  ...APPELLATION_TIER_PHRASES,
  ['appellation', 'dorigine', 'protegee'],
  ['appellation', 'dorigine', 'controlee'],
  ['districtus', 'austriae', 'controllatus'],
];

// The classification field owns its token set: every mark, as a leading OR a
// trailing token. The appellation sets keep 'do' trailing-only and 'dac' out
// because "Rueda, DO" and "Kamptal DAC" are place names there; in the
// classification field neither reading exists, so both are marks.
const CLASSIFICATION_MARK_TOKENS = new Set([...APPELLATION_TIER_TOKENS, ...APPELLATION_LEADING_TIER_TOKENS, 'dac']);

// The French label line that wraps the place in the mark ("Appellation
// Pauillac Contrôlée", "Appellation Saint-Émilion Grand Cru Contrôlée"). The
// old scan prompt asked for "the printed classification/tier line", and on a
// French label that IS this line. Never a tier, whatever place it wraps. A
// token test, not a regex: `^appellation\s+.+\s+…$` is the polynomial-ReDoS
// shape CodeQL flags on this file (js/polynomial-redos), and the value is
// already split on single spaces.
const WRAPPED_MARK_TAILS = new Set(['controlee', 'protegee']);
const isWrappedMarkLine = (parts) =>
  parts.length >= 3 && foldTierWord(parts[0]) === 'appellation' && WRAPPED_MARK_TAILS.has(foldTierWord(parts[parts.length - 1]));

/**
 * The classification to STORE: a quality tier granted on top of the
 * appellation (Riserva, Grand Cru Classé en 1855, Cru Bourgeois, a Prädikat),
 * whitespace folded, with the appellation's regulatory mark — DOCG, DOC, AOC,
 * IGT, AVA, DAC, their dotted and bracketed forms, the spelled-out phrases and
 * the French "Appellation … Contrôlée" line — stripped off either end. The
 * mark follows from the appellation and is no tier, so a value that is only
 * the mark ("DOCG", "(DOC)", "Denominazione di Origine Controllata",
 * "Appellation Pauillac Contrôlée") comes back null and "Riserva DOCG" comes
 * back "Riserva". Null or blank in,
 * null out. One rule for every write path (model hook, mint, admin edit,
 * proposals, drafts) and for the backfill (scripts/normalize-classification-
 * tiers.js) — GitHub discussion #1696.
 */
const normalizeClassification = (classification) => {
  if (classification == null) return null;
  const folded = String(classification).trim().replace(/\s+/g, ' ');
  if (!folded) return null;
  const tokens = folded.split(' ');
  if (isWrappedMarkLine(tokens)) return null;
  const parts = stripTierEdges(tokens, {
    min: 0, phrases: CLASSIFICATION_TIER_PHRASES,
    leading: CLASSIFICATION_MARK_TOKENS, trailing: CLASSIFICATION_MARK_TOKENS,
  });
  const result = trimTrailingChars(parts.join(' '), ' ,').trim();
  return result || null;
};

// A vintage year TRAILING a wine name — imports and label scans routinely
// append it ("Reserve Cabernet Sauvignon 2023"), but the registry is
// vintage-neutral by construction: the year lives on Bottle.vintage.
// TRAILING only, on purpose: leading years are brand names ("1924 Double
// Black", "19 Crimes"), and a mid-name year is part of a cuvée. The window is
// 1950–2049 so historic marks like "1865" (Viña San Pedro's brand) survive
// even at the tail. Optional parens absorb "(2019)".
// The separator run is BOUNDED ({1,8}, not +): an unbounded run before an
// anchored tail is quadratic on a long run of separators that ends in
// nothing — every start position rescans the run (CodeQL js/polynomial-redos
// on the two .replace calls below). Real names carry at most a
// few separator characters before the year (" — (2019)" is four); the
// caller trims whatever a longer run leaves behind.
const TRAILING_VINTAGE_RX = /[\s\-–—(]{1,8}(?:19[5-9]\d|20[0-4]\d)\)?$/;

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
// bucket token: "Caronne Sainte Gemme" / "Caronne Ste Gemme" are one
// Haut-Médoc estate, yet invisible to normalization as such because 'ste' and
// 'sainte' are simply different tokens. The key is comparison-only and non-unique, so a rare false
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
// house. 1000–2049: founding dates reach centuries
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
  // which would split keys that must stay one ("X 1846" vs "X 1846
  // Winery"). Walk back over droppable tail tokens and
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
// The appellation segment of every identity key: a production method on its
// own is no appellation, so it keys as none (isProductionMethodOnly above).
const appellationKeySegment = (appellation) =>
  (isProductionMethodOnly(appellation) ? '' : normalizeString(appellation));
const pendingWineKey = (name, userId, appellation = '', { sweetness = null } = {}) =>
  `${pendingProducerKey(userId)}:${normalizeWineName(name)}:${appellationKeySegment(appellation)}${sweetnessKeySegment(sweetness)}`;

// ── Label sweetness in the identity keys (GitHub discussion #1754) ──────────
// The term a label prints (trocken, Brut Nature) is identity: a Kabinett
// trocken and the Kabinett from the same vineyard are two wines. Once the word
// leaves the name and lives in WineDefinition.labelSweetness, their
// producer:name:appellation keys would coincide under the UNIQUE index — so the
// term rides on every key as a suffix, ONLY when the wine has one. A key
// without a term is byte-identical to what it always was: no stored key moves.
// The segment is the normalised WORD, never an id — a key must be computable
// before the row exists and come out the same on every Bridge server. '#' and
// '=' never survive normalizeString, so the suffixed keys are provably disjoint
// from any plain key, the same argument the '~' namespaces above rest on.
const SWEETNESS_KEY_MARK = '#sw=';
// ß is not decomposable and normalizeString deletes it ("süß" → "su"), so the
// fold runs first — the pre-fold utils/styleTerms applies to names.
const normalizeSweetnessTerm = (term) =>
  normalizeString(String(term == null ? '' : term).toLowerCase().replace(/ß/g, 'ss'));
const sweetnessKeySegment = (term) => {
  const k = normalizeSweetnessTerm(term);
  return k ? `${SWEETNESS_KEY_MARK}${k}` : '';
};
// The key without its suffix. The WineDefinition hook owns the suffix: every
// writer builds the bare key, the hook strips whatever segment is there and
// re-appends the one the wine's term says (models/WineDefinition pre-validate).
const stripSweetnessKeySegment = (key) => {
  const s = String(key == null ? '' : key);
  const at = s.indexOf(SWEETNESS_KEY_MARK);
  return at === -1 ? s : s.slice(0, at);
};

/**
 * The name as the label reads it: the name, then the term — unless the name
 * already carries the word as a whole token (a wine marked sweetnessInName,
 * "Brut Premier"), so nothing is ever doubled. Every text surface shows this
 * (services/sweetnessOps.wineDisplayName); the slug is built from it, which
 * is why a migrated wine's URL does not move when the word leaves its name.
 */
const appendSweetnessTerm = (name, term) => {
  const n = String(name == null ? '' : name).trim();
  const t = String(term == null ? '' : term).trim();
  if (!t) return n;
  if (!n) return t;
  const carried = ` ${normalizeSweetnessTerm(n)} `.includes(` ${normalizeSweetnessTerm(t)} `);
  return carried ? n : `${n} ${t}`;
};

// DRAFT namespace (a wine created privately and published later). Same
// construction and the same argument as the pending
// namespace above — '~' never survives normalizeString, so 'draft~' cannot be
// produced by a real producer, and the creator id keeps two users' drafts of
// the same wine apart under the unique index (they collide only at PUBLISH,
// where the dedup check runs against the ordinary namespace). Unlike the
// pending key it carries the producer segment: a draft usually has one.
// See the `draft` field note on models/WineDefinition.js.
const DRAFT_KEY_PREFIX = 'draft~';
const draftProducerKey = (userId) => `${DRAFT_KEY_PREFIX}${String(userId)}`;
const draftWineKey = (name, producer, userId, appellation = '', { sweetness = null } = {}) =>
  `${draftProducerKey(userId)}:${normalizeString(producer || '')}:${normalizeWineName(name)}:${appellationKeySegment(appellation)}${sweetnessKeySegment(sweetness)}`;

/**
 * Generate a normalized key for wine deduplication
 * Combines producer + wine name + appellation — plus the label sweetness term
 * when the wine has one (see SWEETNESS_KEY_MARK above).
 */
const generateWineKey = (name, producer, appellation = '', { sweetness = null } = {}) => {
  const normalizedName = normalizeWineName(name);
  const normalizedProducer = normalizeString(producer);
  // A method on its own keys as no appellation: the model hook stores it as
  // null, and a lookup must land on that row.
  const normalizedAppellation = appellationKeySegment(appellation);

  // Combine in a consistent order
  return `${normalizedProducer}:${normalizedName}:${normalizedAppellation}${sweetnessKeySegment(sweetness)}`;
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

  // Spelling variants / typos / short forms — mapped so they can never become
  // duplicate Grape docs.
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
  // which would mint a grape document named "70% Monastrell". Strip the
  // percentage and resolve what remains ("70%" alone → '' → caller drops it).
  // Whitespace runs are BOUNDED, not `\s*` (CodeQL js/polynomial-redos).
  // With `\s*` the trailing pattern is retried at
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
 * document for each spelling (USA / United States Of America / Tyskland /
 * Italie / New Zeeland as separate countries).
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

  // ── ISO 3166-1 alpha-2 codes ───────────────────────────────────────────
  //
  // Real files use them: without these entries a row whose country is a
  // two-letter code (de, fr, ro, it, pl, es …) is rejected as an
  // unrecognized country.
  //
  // This is the right place for it rather than the importer: isRecognizedCountry
  // resolves through this map before the mint gate, so one entry fixes the
  // import path, the label scan and the AI lookup together. `us` and `uk`
  // are the same two-letter form.
  //
  // Scoped to the wine world plus its neighbours rather than all 249 codes:
  // every entry here is a country somebody could plausibly type in a wine
  // file, and a shorter list is one a human can still audit.
  //
  // ⚠️ Several of these collide with ordinary words — `it`, `at`, `is`, `in`,
  // `no`, `be`, `me`, `am`, `de`, `es`. That is safe ONLY because this map is
  // consulted for values already claiming to be a COUNTRY (a country column, a
  // label-scan country field), never for free text: in a country field, "de"
  // is Germany. Do not reuse this map for general text normalisation.
  //
  // GB → England follows the same wine-world convention as the existing `uk`
  // entry above, not ISO's political one.

  // Europe — the classical wine countries
  'fr': 'France',            'it': 'Italy',              'es': 'Spain',
  'pt': 'Portugal',          'de': 'Germany',            'at': 'Austria',
  'ch': 'Switzerland',       'gr': 'Greece',             'hu': 'Hungary',
  'ro': 'Romania',           'bg': 'Bulgaria',           'hr': 'Croatia',
  'si': 'Slovenia',          'rs': 'Serbia',             'me': 'Montenegro',
  'mk': 'North Macedonia',   'ba': 'Bosnia and Herzegovina',
  'al': 'Albania',           'md': 'Moldova',            'ua': 'Ukraine',
  'ru': 'Russian Federation', 'ge': 'Georgia',           'am': 'Armenia',
  'az': 'Azerbaijan',        'cz': 'Czech Republic',     'sk': 'Slovakia',
  'pl': 'Poland',            'lu': 'Luxembourg',         'be': 'Belgium',
  'nl': 'Netherlands',       'gb': 'England',            'ie': 'Ireland',
  'dk': 'Denmark',           'se': 'Sweden',             'no': 'Norway',
  'fi': 'Finland',           'cy': 'Cyprus',             'mt': 'Malta',
  'tr': 'Turkey',            'is': 'Iceland',            'lt': 'Lithuania',
  'lv': 'Latvia',            'ee': 'Estonia',            'xk': 'Kosovo',

  // The New World and beyond
  'ca': 'Canada',            'mx': 'Mexico',             'ar': 'Argentina',
  'cl': 'Chile',             'uy': 'Uruguay',            'br': 'Brazil',
  'pe': 'Peru',              'bo': 'Bolivia',            'za': 'South Africa',
  'au': 'Australia',         'nz': 'New Zealand',        'cn': 'China',
  'jp': 'Japan',             'in': 'India',              'il': 'Israel',
  'lb': 'Lebanon',           'ma': 'Morocco',            'dz': 'Algeria',
  'tn': 'Tunisia',           'eg': 'Egypt',              'kr': 'South Korea',
  'th': 'Thailand',          'vn': 'Vietnam',
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
 * Longest a producer may be and still be condemned for consisting of nothing
 * but house/stop words.
 *
 * The bound exists because WINE_STOP_WORDS is broad — it holds 'the', 'de',
 * 'la', 'e', 'estate', 'wine', 'reserve' — so a LONG string can fold to zero
 * tokens without being a placeholder at all. 15 characters is the length of the
 * longest shape this rule is meant to catch ("The Wine Estate"); anything
 * longer is left to a human. Normalized chars, not raw.
 */
const ALL_STOP_WORD_PRODUCER_MAX = 15;

/**
 * Is this producer+name pair so degenerate that it CANNOT be an identity?
 *
 * READ THIS BEFORE WIDENING IT. This predicate BLOCKS — a true verdict refuses
 * a mint, refuses an auto-promotion and refuses a curator's write. Its first
 * version tried to judge identity QUALITY from string shape and condemned an
 * entire category of real wine. Measured against 91 real producer/name pairs it
 * blocked 67 of them:
 *
 *   • `p === n` — the single-wine estate, which is not a defect but a whole way
 *     of making wine: Château Margaux, Petrus, Krug, Salon, Dom Pérignon, Veuve
 *     Clicquot, Pol Roger, Opus One, Screaming Eagle, Sassicaia, Masseto,
 *     Ornellaia, Tignanello, Château Musar, Château Rayas, Zind-Humbrecht,
 *     J.J. Prüm. The producer IS the wine. There is nothing wrong with the row.
 *   • the stop-word-stripped containment test — Domaine de la Romanée-Conti /
 *     "Romanée-Conti", Harlan Estate / "Harlan", Domaine Leflaive / "Leflaive",
 *     Weingut Keller / "Keller", Casa Ferreirinha / "Ferreirinha", Viña Vik /
 *     "Vik", Duckhorn / "Duckhorn Vineyards". Dropping the house word is how
 *     labels and databases have always disagreed; it is not a missing producer.
 *   • digits-only — the Penedès house "1+1=3" normalizes to '113', and "1865"
 *     is Viña San Pedro's range. Both real, both condemned.
 *
 * THE LESSON: producer == name is not a defect, it is a category of wine.
 * Almost nothing about identity QUALITY can be judged safely from string shape
 * alone. So the suspicion moved to where a human can overrule it — the
 * cross-field review queue's `producer-echoes-name.v1`
 * (utils/crossFieldChecks) — and what is left here is only what cannot possibly
 * be an identity in any language, under any label convention:
 *
 *   1. a producer shorter than 2 characters after normalization — a stray
 *      keystroke, the same bar findOrCreateWine's mint gate has always applied;
 *   2. a producer that is nothing but house/stop words AND short ("Domaine",
 *      "Casa", "The Wine Estate") — branding with no house attached to it.
 *
 * That is the whole list. It is deliberately almost empty.
 *
 * CONTRACT — synchronous, pure and DEPENDENCY-FREE, because its primary caller
 * is the WineDefinition pre-validate hook, which must not do DB I/O. Everything
 * here is a string-shape test. The taxonomy-dependent half of "is this a real
 * producer?" ("is it actually a place / a grape?") needs the DB and lives
 * elsewhere: the mint gate in services/findOrCreateWine and the cross-field
 * rules in utils/crossFieldChecks, enforced on the curation write path
 * (services/pendingWineOps.applyPendingFix).
 *
 * `name` is still a parameter, and still consulted for two things only: the
 * non-Latin exemption below, and the MISSING-is-not-my-verdict rule. It no
 * longer takes part in any blocking test.
 *
 * NON-LATIN identities are exempt. normalizeString cannot see them, so both
 * folds below would read "empty" and condemn a real producer — the H-4
 * regression that made "Мукузани" rows unpromotable.
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

  // 1. A one-character producer is a stray keystroke — same bar the mint gate
  //    has always applied (findOrCreateWine's producerNorm.length < 2).
  if (p.length < 2) return true;

  // 2. A producer that is nothing but house/stop words ("Domaine", "Casa",
  //    "The Wine Estate") — branding with no house attached to it. Length-
  //    bounded so a long real name cannot be swallowed by a broad stop list;
  //    see ALL_STOP_WORD_PRODUCER_MAX.
  if (p.length <= ALL_STOP_WORD_PRODUCER_MAX && tokenize(producer).length === 0) return true;

  return false;
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
 *
 * Built from the DISPLAY name — the name followed by the label sweetness term
 * when the wine has one (appendSweetnessTerm) — so "Riesling Kabinett" with
 * the term trocken keeps the URL it had while the word was in its name.
 */
const generateWineSlug = (name, producer, sweetness = null) => {
  const shown = appendSweetnessTerm(name, sweetness);
  const nName = normalizeString(shown);
  const nProducer = normalizeString(producer);
  if (!nName) return slugify(producer);
  if (!nProducer || nName === nProducer || nName.startsWith(nProducer + ' ')) {
    return slugify(shown);
  }
  return slugify(`${producer} ${shown}`);
};


module.exports = {
  normalizeString,
  spellStarGrades,
  normalizeWineName,
  SWEETNESS_KEY_MARK,
  normalizeSweetnessTerm,
  sweetnessKeySegment,
  stripSweetnessKeySegment,
  appendSweetnessTerm,
  MAX_STAR_GRADE,
  sanitizeTaxonomyName,
  slugify,
  tokenize,
  generateWineKey,
  PENDING_KEY_PREFIX,
  pendingProducerKey,
  pendingWineKey,
  DRAFT_KEY_PREFIX,
  draftProducerKey,
  draftWineKey,
  generateWineSlug,
  GRAPE_SYNONYMS,
  normalizeProducerKey,
  foldProducerToken,
  normalizeAppellation,
  normalizeAppellationKey,
  isProductionMethodOnly,
  normalizeClassification,
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
