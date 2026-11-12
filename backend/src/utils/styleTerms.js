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

const { normalizeString, spellStarGrades, MAX_STAR_GRADE, SWEETNESS_ALIASES } = require('./normalize');

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
  'suss', 'edes', 'fruchtsuss',
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
  // An OBSERVED misspelling, not a guess: "Trokenbeerenauslese" (one c, one
  // s) occurs in real cellar exports, written that way by the exporting
  // owner. Present because it was seen in real data. This map is not a
  // general typo-tolerance scheme and should not grow into one: every entry
  // needs a file behind it.
  ['trokenbeerenauslese', 'trockenbeerenauslese'],
]);

// The sweetness twin of PRADIKAT_ALIASES, for the same keyboard: "Süß" typed
// without the umlaut is "Suess", which normalizeString leaves alone — without
// this the guard silently fails open for the standard ue-transliteration.
// "Troken" comes from the same cellar export as the Prädikat typo above.
// NAME side only, like the Prädikat map: the producer-field rules in
// crossFieldChecks read SWEETNESS_WORDS directly and must NOT gain 'suess' —
// Suess is a real surname, and flagging every "Weingut Suess" as a style-term
// producer is the 'dry'/'sweet' problem over again. The map lives in
// utils/normalize (SWEETNESS_ALIASES), where the label sweetness write rule
// and the display name read names through it too.

// Style words that are also ordinary name words. "Dry Creek Zinfandel" states
// no sweetness, and "Sweet Cheeks Pinot" is a winery. Excluded from the NAME
// guard, and never taken out of a name by the label sweetness write rule
// (services/sweetnessWrite) — they stay in SWEETNESS_WORDS, where the
// producer-field rules read a whole-string match and cannot be fooled this way.
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

// A producer's own grade inside a Prädikat, printed as stars ("Auslese**",
// "Auslese***" at Markus Molitor): spellStarGrades turns a run of stars into
// one of these words. Each grade is its own wine, so two names stating
// different grades are two wines, exactly like two Prädikate. Bounded by
// MAX_STAR_GRADE: a typed "400000000star" is text, not a grade (an unbounded
// count fed '*'.repeat in the reason below — release audit 2026-10-13).
const STAR_GRADE_TOKEN = new RegExp(`^[1-${MAX_STAR_GRADE}]star$`);

/**
 * The style a NAME declares, as independent term sets.
 *
 * @param {string} name
 * @returns {{pradikat: Set<string>, sweetness: Set<string>, grade: Set<string>}}
 */
function statedStyle(name) {
  // Lowercase BEFORE the ß-fold: the capital eszett ẞ (U+1E9E — the official
  // uppercase form, routine on all-caps German labels) only becomes ß under
  // toLowerCase, and folding first left it for normalizeString to delete as
  // punctuation, silently dropping the sweetness term (post-release audit,
  // verified by execution: "SÜẞ" read as stating nothing).
  let folded = normalizeString(spellStarGrades(String(name == null ? '' : name).toLowerCase().replace(/ß/g, 'ss')));
  for (const [re, joined] of JOINED_PHRASES) folded = folded.replace(re, joined);

  const pradikat = new Set();
  const sweetness = new Set();
  const grade = new Set();
  for (const token of folded.split(/[^a-z0-9]+/)) {
    if (!token) continue;
    if (STAR_GRADE_TOKEN.test(token)) { grade.add(token); continue; }
    const tier = PRADIKAT_ALIASES.get(token) || token;
    if (PRADIKAT_WORDS.has(tier)) { pradikat.add(tier); continue; }
    const sweet = SWEETNESS_ALIASES.get(token) || token;
    if (SWEETNESS_WORDS.has(sweet) && !NAME_AMBIGUOUS_WORDS.has(sweet)) sweetness.add(sweet);
  }
  return { pradikat, sweetness, grade };
}

/**
 * Is this appellation value a ripeness Prädikat rather than a place?
 *
 * Some cellar exports put the Prädikat in the appellation column ("Auslese",
 * "Trockenbeerenauslese"). Stored as written, those wines end up with NO
 * appellation at all, which is exactly the thin-identity condition that makes
 * auto-enrichment decline them permanently: a data-entry habit quietly costs
 * the owner their tasting notes. It can be worse than useless — a wine named
 * "Riesling Trocken" (bone dry) whose appellation claims the sweetest botrytis
 * category German law defines would, curated at face value, produce a
 * decades-long dessert-wine window on a dry estate Riesling.
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
 * Appellation "Trockenbeerenauslese" on a wine named "Riesling Trocken" puts
 * the sweetest botrytis category German law defines on a bone-dry wine. Both
 * cannot be true. Moving that value into the classification would keep the
 * falsehood and merely change which field carries it, and a classification is
 * read as curated fact: it would argue for a decades-long dessert-wine window
 * on an estate dry Riesling.
 *
 * So a contradicted Prädikat is DROPPED, not rescued — the appellation is still
 * cleared of it, because a ripeness level is not a place whether or not it is
 * true. What is left is an honest gap, which is the state that asks a curator
 * to fill it. An uncontradicted Prädikat (an Auslese on a plain Riesling)
 * still moves to an empty classification.
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


// The Prädikat tiers a wine's classification rows of kind `ripeness` state.
const ripenessTiers = (rows) => {
  const tiers = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row === 'object' && row.kind === 'ripeness' && typeof row.name === 'string') {
      for (const t of statedStyle(row.name).pradikat) tiers.add(t);
    }
  }
  return tiers;
};

/**
 * The Prädikat a wine states that is sweet BY LAW (ALWAYS_SWEET_PRADIKAT) —
 * in its name, its ripeness classification rows or its classification
 * string — or null. The label sweetness write rule (services/sweetnessWrite)
 * holds a dry-side TERM against it, as pradikatContradictsName holds a dry
 * name. Accepts a bare name too.
 *
 * @param {string|{name?:string, classifications?:any[], classification?:string}} wineLike
 * @returns {string|null} the tier, normalised ("trockenbeerenauslese")
 */
function sweetByLawPradikat(wineLike) {
  const w = wineLike == null || typeof wineLike === 'string' ? { name: wineLike } : wineLike;
  const tiers = new Set([...statedStyle(w.name).pradikat, ...ripenessTiers(w.classifications)]);
  if (typeof w.classification === 'string') for (const t of statedStyle(w.classification).pradikat) tiers.add(t);
  return [...tiers].sort().find((t) => ALWAYS_SWEET_PRADIKAT.has(t)) || null;
}

const subset = (a, b) => [...a].every((x) => b.has(x));

// Both sides state something, and neither statement contains the other. A
// subset is not a disagreement: "Brut" vs "Brut Rosé" is one wine written two
// ways, "Brut" vs "Demi-Sec" is two wines.
const disagree = (a, b) => a.size > 0 && b.size > 0 && !subset(a, b) && !subset(b, a);

const ID_RX = /^[0-9a-f]{24}$/i;
// The label sweetness term on a wine-like object: the populated row's word,
// or — for an unpopulated ref — the word the term table's in-memory copy
// knows (services/sweetnessOps, when it is warm; a belt for a caller that
// forgot the populate). Never a bare string as the word: a string here is an
// id or nothing, so no caller can smuggle a word in past the term table.
const fieldTerm = (w) => {
  const t = w && w.labelSweetness;
  if (!t) return null;
  if (typeof t === 'object' && typeof t.name === 'string' && t.name.trim()) return t.name.trim();
  const id = typeof t === 'string' ? t : (typeof t.toString === 'function' ? t.toString() : '');
  if (!ID_RX.test(id)) return null;
  // Lazy: sweetnessOps loads the model; this util must stay requirable alone.
  return require('../services/sweetnessOps').cachedTermName(id);
};

/**
 * The style a WINE declares — the record first, the name as the fallback.
 *
 * Label sweetness moved into a field of its own (WineDefinition.labelSweetness,
 * GitHub discussion #1754), and the word is leaving the names it used to ride
 * in. A guard that read only names would then go blind on exactly the wines it
 * was built for (#1134), so this reads the field where the record carries it
 * and the name where it does not: a row from before the migration, a name a
 * scan or an import typed, a Bridge peer on the older protocol. The ripeness
 * tier likewise: the classification rows of kind `ripeness` count beside any
 * Prädikat the name states.
 *
 * Accepts a plain name string too, so every caller that held a string keeps
 * working. The sweetness set is the same token set statedStyle builds, so a
 * field term and a name compare like two names; `term` carries the field's
 * own word (normalised) for the exact comparison two fields allow.
 *
 * @param {string|{name?:string, labelSweetness?:any, classifications?:any[]}} wineLike
 * @returns {{pradikat: Set<string>, sweetness: Set<string>, grade: Set<string>, term: string|null, termName: string|null}}
 */
function styleOf(wineLike) {
  if (wineLike == null || typeof wineLike === 'string') {
    return { ...statedStyle(wineLike), term: null, termName: null };
  }
  const fromName = statedStyle(wineLike.name);
  const pradikat = new Set([...fromName.pradikat, ...ripenessTiers(wineLike.classifications)]);
  const termName = fieldTerm(wineLike);
  if (!termName) return { pradikat, sweetness: fromName.sweetness, grade: fromName.grade, term: null, termName: null };
  // The field is an explicit statement, so a word the NAME tokenizer would
  // leave out ("Mild", "Medium Dry" — 'dry' is ambiguous in a name, not here)
  // still counts: the whole term stands in as one token when nothing else does.
  const term = normalizeString(termName.toLowerCase().replace(/ß/g, 'ss'));
  const sweetness = statedStyle(termName).sweetness;
  if (sweetness.size === 0 && term) sweetness.add(term);
  return { pradikat, sweetness, grade: fromName.grade, term, termName };
}

/** Does this wine state a label sweetness at all — in its record or its name? */
function sweetnessStated(wineLike) {
  return styleOf(wineLike).sweetness.size > 0;
}

/**
 * Do these two wines declare a DIFFERENT style? A non-null return means they
 * are two wines and must never be linked without the user saying so. Each side
 * may be a wine-like object (record + name, see styleOf) or a bare name.
 *
 * Where BOTH sides carry the field, the terms compare exactly — "Brut Nature"
 * and "Brut" are two wines, which the token comparison below (built for names,
 * where "Brut" ⊂ "Brut Rosé" must stay one wine) cannot tell apart. One field
 * against one name compares as two names do.
 *
 * @param {string|object} wineA
 * @param {string|object} wineB
 * @returns {string|null} human-readable reason, or null when compatible
 */
function conflictingStyleTerms(wineA, wineB) {
  const a = styleOf(wineA);
  const b = styleOf(wineB);
  if (disagree(a.pradikat, b.pradikat)) {
    return `each name states a different Prädikat (${[...a.pradikat].sort().join(', ')} vs ${[...b.pradikat].sort().join(', ')})`;
  }
  if (a.term && b.term) {
    if (a.term !== b.term) return `each records a different label sweetness (${a.termName} vs ${b.termName})`;
  } else if (disagree(a.sweetness, b.sweetness)) {
    return `each name states a different sweetness (${[...a.sweetness].sort().join(', ')} vs ${[...b.sweetness].sort().join(', ')})`;
  }
  if (disagree(a.grade, b.grade)) {
    const stars = (set) => [...set].sort().map((g) => '*'.repeat(parseInt(g, 10))).join(', ');
    return `each name states a different star grade (${stars(a.grade)} vs ${stars(b.grade)})`;
  }
  return null;
}

module.exports = {
  SWEETNESS_WORDS,
  SWEETNESS_ALIASES,
  NAME_AMBIGUOUS_WORDS,
  statedStyle,
  styleOf,
  sweetnessStated,
  conflictingStyleTerms,
  pradikatContradictsName,
  pradikatOnlyValue,
  sweetByLawPradikat,
};

/**
 * Route a bare Prädikat out of an appellation — the one rule for EVERY mint
 * (findOrCreateWine and the two admin routes that build a WineDefinition
 * themselves; audit 2026-09-07). Returns the appellation to store (null when
 * it was only the Prädikat) and the classification: the caller's own when
 * given, else the Prädikat unless the name contradicts it.
 */
function splitPradikatFromAppellation(appellation, classification, name) {
  const ap = typeof appellation === 'string' ? appellation.trim() : '';
  const keep = typeof classification === 'string' && classification.trim() ? classification.trim() : null;
  const pradikat = pradikatOnlyValue(ap);
  if (!pradikat) return { appellation: ap || null, classification: keep };
  return { appellation: null, classification: keep || (pradikatContradictsName(pradikat, name || '') ? null : pradikat) };
}
module.exports.splitPradikatFromAppellation = splitPradikatFromAppellation;
