/**
 * Declared style terms — the label words that ARE the wine.
 *
 * Issue #1134. A Mosel estate's Riesling range came back from label scanning
 * filed under ONE registry row: "Brauneberger Juffer-Sonnenuhr Riesling
 * Spätlese Alte Reben", "… Auslese" and "… Spätlese Feinherb" all landed on
 * the Feinherb entry. Nothing was broken in the scorer — the composite is
 * name×0.45 + producer×0.45 + appellation×0.10, and on a range from one estate
 * in one vineyard the producer and appellation axes both score 1.0. That fixes
 * 0.55 before the name is read, so a name only has to reach 0.44 to clear the
 * scan path's old 0.75 floor. Measured against the real registry rows:
 *
 *   … Riesling Spätlese Alte Reben  vs … Spätlese Feinherb ......... 0.8749
 *   … Riesling Auslese              vs … Spätlese Feinherb ......... 0.8457
 *   … Riesling Kabinett             vs … Spätlese Feinherb ......... 0.8339
 *   … Riesling Spätlese Trocken     vs … Spätlese Feinherb ......... 0.8962
 *
 * String distance cannot separate these: the names differ by one short word at
 * the tail, and that word is the entire difference between two wines. No
 * threshold move helps — reaching below 0.83 to split them would fold apart
 * wines that really are the same. The signal has to come from KNOWING which
 * words carry identity, which is what this module supplies.
 *
 * Two vocabularies, deliberately separate because they are independent axes of
 * a German label and a wine states both: the PRÄDIKAT (must weight at harvest
 * — Kabinett through Trockenbeerenauslese) and the SWEETNESS of the finished
 * wine (trocken / halbtrocken / feinherb / lieblich). "Spätlese Trocken" and
 * "Spätlese Feinherb" share a Prädikat and are still two different bottles.
 *
 * THE GUARD IS A REJECT, NEVER A MERGE. conflictingStyleTerms only ever says
 * "these are two wines" — it can stop a link, it can never cause one. So its
 * failure mode is a duplicate registry row a curator merges, not a user's
 * bottle silently filed under someone else's wine. Same asymmetry the
 * label-variant detector is built on (services/labelVariantMatch), and the
 * same shape of rule: where both sides state a DIFFERENT value it is a hard
 * reject; where one side is silent it is silence, not disagreement.
 */

const { normalizeString } = require('./normalize');

// Sweetness / dryness across label languages, pre-normalized (normalizeString
// folds "Roșu" → 'rosu', "off-dry" → 'offdry'; ß is not decomposable and is
// stripped outright, so callers that care pre-fold ß→ss — "süß" → 'suss').
//
// SINGLE SOURCE OF TRUTH: utils/crossFieldChecks builds its producer-is-a-
// style-term vocabulary from this set. It used to hold its own copy, and a
// third copy here would be two lists too many.
const SWEETNESS_WORDS = new Set([
  'demidulce', 'demisec', 'dulce', 'seco', 'semiseco', 'semidulce',
  'abboccato', 'amabile', 'halbtrocken', 'feinherb', 'trocken', 'lieblich',
  'offdry', 'semisweet', 'moelleux', 'doux', 'brut', 'sec', 'dry', 'sweet',
  'suss', 'edes',
]);

// Prädikat tiers — the German/Austrian must-weight ladder. Each is a distinct
// wine from the same vineyard in the same year, which is precisely why a
// producer bottles several of them and why they collide in the scorer.
//
// Whole-token matching only, so the substring nesting is not a problem:
// 'trockenbeerenauslese', 'beerenauslese' and 'auslese' are three separate
// tokens, never one containing another.
const PRADIKAT_WORDS = new Set([
  'kabinett',
  'spatlese',
  'auslese',
  'beerenauslese',
  'trockenbeerenauslese',
  'eiswein',
  // Austrian tiers above Beerenauslese — same ladder, same collision.
  'ausbruch', 'strohwein', 'schilfwein',
]);

// Spellings of the SAME tier, folded to one term before comparison.
// normalizeString folds ä→a but leaves a typed-out "Spaetlese" as 'spaetlese',
// and without this "Riesling Spaetlese" vs "Riesling Spätlese" — one wine,
// two keyboards — would read as a Prädikat conflict and refuse to link.
const PRADIKAT_ALIASES = new Map([
  ['spaetlese', 'spatlese'],
  ['icewine', 'eiswein'],
  // An OBSERVED misspelling, not a guess: one owner's export carried
  // "Trokenbeerenauslese" (one c, one s) in its appellation column, and the
  // same file misspelled the wine's own name "Riesling Troken" — which is how
  // we know the typo is the writer's rather than ours (somm ticket 6a966386,
  // 2026-09-01). Added because it was seen in real data. This map is not a
  // general typo-tolerance scheme and should not grow into one: every entry
  // needs a file behind it.
  ['trokenbeerenauslese', 'trockenbeerenauslese'],
]);

// The sweetness twin of PRADIKAT_ALIASES, for the same keyboard: "Süß" typed
// without the umlaut is "Suess", which normalizeString leaves alone — without
// this the guard silently fails open for the standard ue-transliteration
// (found by the post-release audit, verified by execution). NAME side only,
// like the Prädikat map: the producer-field rules in crossFieldChecks read
// SWEETNESS_WORDS directly and must NOT gain 'suess' — Suess is a real
// surname, and flagging every "Weingut Suess" as a style-term producer is
// the 'dry'/'sweet' problem over again.
const SWEETNESS_ALIASES = new Map([
  ['suess', 'suss'],
  // Same file as the Prädikat typo above: it wrote the wine's own name
  // "Riesling Troken". Name side only, like every entry here — SWEETNESS_WORDS
  // itself must not gain it, for the 'Weingut Suess' reason given above.
  ['troken', 'trocken'],
]);

// Style words that are also ordinary name words. "Dry Creek Zinfandel" states
// no sweetness, and "Sweet Cheeks Pinot" is a winery. Excluded from the NAME
// guard only — they stay in SWEETNESS_WORDS, where the producer-field rules
// read a whole-string match and cannot be fooled this way.
const NAME_AMBIGUOUS_WORDS = new Set(['dry', 'sweet']);

// Two-word spellings that normalize to two tokens while their hyphenated form
// normalizes to one ("Demi-Sec" → 'demisec', "Demi Sec" → 'demi sec'). Joined
// before tokenizing so both spellings produce the same term — otherwise the
// same wine written two ways would read as a conflict.
const JOINED_PHRASES = [
  [/\bdemi sec\b/g, 'demisec'],
  [/\bsemi seco\b/g, 'semiseco'],
  [/\bsemi dulce\b/g, 'semidulce'],
  [/\bsemi sweet\b/g, 'semisweet'],
  [/\boff dry\b/g, 'offdry'],
];

/**
 * The style a NAME declares, as two independent term sets.
 *
 * @param {string} name
 * @returns {{pradikat: Set<string>, sweetness: Set<string>}}
 */
function statedStyle(name) {
  // Lowercase BEFORE the ß-fold: the capital eszett ẞ (U+1E9E — the official
  // uppercase form, routine on all-caps German labels) only becomes ß under
  // toLowerCase, and folding first left it for normalizeString to delete as
  // punctuation, silently dropping the sweetness term (post-release audit,
  // verified by execution: "SÜẞ" read as stating nothing).
  let folded = normalizeString(String(name == null ? '' : name).toLowerCase().replace(/ß/g, 'ss'));
  for (const [re, joined] of JOINED_PHRASES) folded = folded.replace(re, joined);

  const pradikat = new Set();
  const sweetness = new Set();
  for (const token of folded.split(/[^a-z0-9]+/)) {
    if (!token) continue;
    const tier = PRADIKAT_ALIASES.get(token) || token;
    if (PRADIKAT_WORDS.has(tier)) { pradikat.add(tier); continue; }
    const sweet = SWEETNESS_ALIASES.get(token) || token;
    if (SWEETNESS_WORDS.has(sweet) && !NAME_AMBIGUOUS_WORDS.has(sweet)) sweetness.add(sweet);
  }
  return { pradikat, sweetness };
}

/**
 * Is this appellation value a ripeness Prädikat rather than a place?
 *
 * Some cellar exports put the Prädikat in the appellation column — one file
 * carried "Auslese" for a Mosel Riesling and "Trokenbeerenauslese" for a Nahe
 * one (somm ticket 6a966386). Stored as written, those wines end up with NO
 * appellation at all, which is exactly the thin-identity condition that makes
 * auto-enrichment decline them permanently: a data-entry habit quietly costs
 * the owner his tasting notes. One of the two was worse than useless — a wine
 * named "Riesling Trocken" (bone dry) whose appellation claimed the sweetest
 * botrytis category German law defines, which curated at face value would have
 * produced a 35-year dessert-wine window on a dry estate Riesling.
 *
 * DELIBERATELY STRICT. Only a value whose every meaningful token is a Prädikat
 * qualifies, so "Auslese" is routed and "Auslese Goldkapsel" is not: the
 * second carries a token this vocabulary cannot vouch for, and moving a value
 * that might name a place would trade one wrong field for another. Refusing
 * the uncertain case is the point — a place is never a Prädikat, but a string
 * containing one is not necessarily free of a place.
 *
 * @param {string} value the appellation as written
 * @returns {string|null} the value trimmed, when it is purely a Prädikat
 */
function pradikatOnlyValue(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const folded = normalizeString(raw.toLowerCase().replace(/ß/g, 'ss'));
  const tokens = folded.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const everyTokenIsPradikat = tokens.every((t) => PRADIKAT_WORDS.has(PRADIKAT_ALIASES.get(t) || t));
  return everyTokenIsPradikat ? raw : null;
}

// Prädikat tiers that are sweet BY LAW — botrytis or frost concentrate the
// must so far that no dry version can exist. Kabinett, Spätlese and Auslese are
// deliberately ABSENT: all three are routinely bottled trocken, and "Spätlese
// Trocken" is one of the most common label pairs in Germany.
const ALWAYS_SWEET_PRADIKAT = new Set([
  'beerenauslese', 'trockenbeerenauslese', 'eiswein',
  'ausbruch', 'strohwein', 'schilfwein',
]);

// Unambiguously dry-to-off-dry. Deliberately narrower than "not sweet": the
// medium terms (demi-sec, abboccato, moelleux) are omitted because the point is
// to be certain of the contradiction, not to catch every one.
const DRY_SIDE_WORDS = new Set(['trocken', 'halbtrocken', 'feinherb', 'sec', 'seco', 'brut']);

/**
 * Does this Prädikat contradict the wine it is attached to?
 *
 * The second ticket record is why this exists. Its file said appellation
 * "Trokenbeerenauslese" on a wine named "Riesling Trocken" — the sweetest
 * botrytis category German law defines, on a bone-dry wine. Both cannot be
 * true. Moving that value into the classification would keep the falsehood and
 * merely change which field carries it, and a classification is read as
 * curated fact: it would have argued for a decades-long dessert-wine window on
 * an estate dry Riesling.
 *
 * So a contradicted Prädikat is DROPPED, not rescued — the appellation is still
 * cleared of it, because a ripeness level is not a place whether or not it is
 * true. What is left is an honest gap, which is the state that asks a curator
 * to fill it. That is independently the judgement the sommelier reached on
 * these two records (proposals 6a965b0e / 6a965b19, 2026-09-01): Auslese kept
 * as a classification, Trockenbeerenauslese dropped.
 *
 * @param {string} pradikat a value pradikatOnlyValue has already vouched for
 * @param {string} wineName the name the wine is being minted under
 * @returns {string|null} human-readable reason, or null when compatible
 */
function pradikatContradictsName(pradikat, wineName) {
  const tiers = statedStyle(pradikat).pradikat;
  const sweetTier = [...tiers].find((t) => ALWAYS_SWEET_PRADIKAT.has(t));
  if (!sweetTier) return null;
  const dry = [...statedStyle(wineName).sweetness].filter((w) => DRY_SIDE_WORDS.has(w));
  if (dry.length === 0) return null;
  return `${sweetTier} is sweet by definition, but the name states ${dry.sort().join(', ')}`;
}


const subset = (a, b) => [...a].every((x) => b.has(x));

// Both sides state something, and neither statement contains the other. A
// subset is not a disagreement: "Brut" vs "Brut Rosé" is one wine written two
// ways, "Brut" vs "Demi-Sec" is two wines.
const disagree = (a, b) => a.size > 0 && b.size > 0 && !subset(a, b) && !subset(b, a);

/**
 * Do these two wine names declare a DIFFERENT style? A non-null return means
 * they are two wines and must never be linked without the user saying so.
 *
 * @param {string} nameA
 * @param {string} nameB
 * @returns {string|null} human-readable reason, or null when compatible
 */
function conflictingStyleTerms(nameA, nameB) {
  const a = statedStyle(nameA);
  const b = statedStyle(nameB);
  if (disagree(a.pradikat, b.pradikat)) {
    return `each name states a different Prädikat (${[...a.pradikat].sort().join(', ')} vs ${[...b.pradikat].sort().join(', ')})`;
  }
  if (disagree(a.sweetness, b.sweetness)) {
    return `each name states a different sweetness (${[...a.sweetness].sort().join(', ')} vs ${[...b.sweetness].sort().join(', ')})`;
  }
  return null;
}

module.exports = {
  SWEETNESS_WORDS,
  PRADIKAT_WORDS,
  NAME_AMBIGUOUS_WORDS,
  statedStyle,
  conflictingStyleTerms,
  pradikatContradictsName,
  pradikatOnlyValue,
};
