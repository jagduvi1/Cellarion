/**
 * Label sweetness — the write rule. services/sweetnessOps holds the term table,
 * the resolver and the read shapes; this module is what a WRITE runs:
 *
 *   extractFromName / extractLoaded — the sweetness word a wine's NAME carries
 *     as a word of its own, and the name without it ("Riesling Kabinett
 *     trocken" → "Riesling Kabinett" + trocken). A reading only: what to do
 *     with it is the caller's decision.
 *   assignSweetness — THE write rule for labelSweetness. An explicit term is
 *     resolved on the wine's scale and held against the word in the name and
 *     against a Prädikat that is sweet by law; with the extract switch on
 *     (config/constants SWEETNESS_EXTRACT_FROM_NAME), the word in a name being
 *     written moves into the field.
 *
 * Kept apart from sweetnessOps because every read surface imports that module
 * and none of them needs this one: the rule has its own vocabulary (the
 * ambiguity kinds, the review markers, the switch), and a reader looking for
 * what happens when a term is written finds all of it here.
 *
 * No write path calls the rule yet.
 */
const mongoose = require('mongoose');
const constants = require('../config/constants');
const { normalizeSweetnessTerm } = require('../utils/normalize');
const { NAME_AMBIGUOUS_WORDS, SWEETNESS_ALIASES, statedStyle, sweetByLawPradikat } = require('../utils/styleTerms');
const { loadTerms, resolveLoaded, scaleForType } = require('./sweetnessOps');

// A word of a name: letters (with their marks) and digits. Everything else —
// spaces, commas, hyphens, apostrophes, brackets — stands between words.
const WORD_RX = /[\p{L}\p{M}\p{N}]+/gu;
// What may stand between the words of ONE term in a name: spaces and every
// dash ("Brut Nature", "Extra-Brut", "Demi–Sec"), the soft hyphen and the
// zero-width joiners a pasted label carries. A comma or a slash ends a term.
const TERM_GAP_RX = /^[\s\p{Pd}−­​-‍]+$/u;
// Glue that makes one word of two ("Demi/Sec", "Brut.Rosé", "L'Extra Brut"):
// a term attached to a neighbour by it is not read.
const GLUE_RX = /^[/.'’`´]+$/u;
const isDash = (ch) => /^[\p{Pd}−]$/u.test(ch || '');
const isSpace = (ch) => /^\s$/u.test(ch || '');
// The separators a cut may leave dangling. Attached ones sit against the word
// before them ("Riesling, trocken" → "Riesling,"); spaced ones stand between
// two spaces ("Riesling - trocken"), and only those are a separator — a dash
// glued to a word is part of it ("-S-").
const ATTACHED_SEPS = new Set([',', ';', ':', '.']);
const SPACED_SEPS = new Set(['-', '‐', '‑', '‒', '–', '—', '―', '−', '/', '|', '·']);
// Brackets and quotes whose pair the cut empties ("Riesling (trocken)").
const PAIRS = { '(': ')', '[': ']', '"': '"', '“': '”', '„': '“', '«': '»', '»': '«' };
const OPENERS = new Set(Object.keys(PAIRS));
const CLOSERS = new Set(Object.values(PAIRS));
// Words that change the term beside them: "Semi-Secco" is not secco, "halb
// trocken" not trocken, "Ultra Brut" not Brut, "Brut Zéro Dosage" not Brut.
// A hit next to one is not read.
const MODIFIERS = new Set(['semi', 'demi', 'halb', 'half', 'meio', 'medio', 'extra', 'ultra', 'zero', 'nature', 'dosage']);
const ID_RX = /^[0-9a-f]{24}$/i;
// A name longer than this is not read for a term: no label prints one, and
// the reading must stay cheap on whatever a caller hands in.
const NAME_MAX = 300;

// The sweetnessReview.detail limit (models/WineDefinition), and the longest a
// word sent by a caller is echoed back (a message, a marker, `unresolved`).
const DETAIL_MAX = 300;
const ECHO_MAX = 60;
const clip = (s) => String(s).slice(0, DETAIL_MAX);
/** A caller's word as one short, quoted line: no line breaks, no markup. */
function quote(s) {
  const flat = String(s == null ? '' : s).replace(/[\p{C}\s]+/gu, ' ').replace(/[<>]/g, '').trim();
  return `"${flat.length > ECHO_MAX ? `${flat.slice(0, ECHO_MAX - 1)}…` : flat}"`;
}
const echo = (s) => quote(s).slice(1, -1);

// The bands no Prädikat that is sweet by law can carry: the dry and off-dry
// bands of the still scale, and the sparkling bands up to extra dry. Read by
// band so a term in any language counts ("secco", "száraz", "Pas Dosé"). It
// holds more than DRY_SIDE_WORDS in utils/styleTerms, which reads the words of
// a NAME and leaves the off-dry demi-sec, abboccato and medium dry out to be
// certain: a TERM is an explicit statement, so its band is certain.
const DRY_SIDE_BANDS = new Set(['dry', 'off-dry', 'brut-nature', 'extra-brut', 'brut', 'extra-dry']);

// The ambiguities that mark a wine for a curator when the switch reads a name
// being written. A term inside a longer word is reported to the caller but
// not marked (every Prosecco and every Dolcetto carries one, and neither
// states a sweetness), and so is a name too long to read.
const MARKED_AMBIGUITIES = new Set(['english_word', 'two_terms', 'not_at_end', 'no_scale', 'modifier', 'glued_word', 'place_word', 'untidy_cut']);

const idOf = (v) => (v && typeof v === 'object' && v._id ? v._id : v);
const sameId = (a, b) => a != null && b != null && String(idOf(a)) === String(idOf(b));
const scaleWords = (scale) => (scale === 'sparkling' ? 'a sparkling wine' : 'a still wine');
const isDoc = (target) => target instanceof mongoose.Document;

/**
 * A term as a caller may send it: a string (the word as printed, or a term
 * row id) or an ObjectId. Anything else — an array, a number, an object — is
 * no word at all and reads as an unknown one: { word, invalid }.
 */
function wordOf(value) {
  if (typeof value === 'string') return { word: value.trim() };
  if (value instanceof mongoose.Types.ObjectId) return { word: String(value) };
  return { word: '[not a word]', invalid: true };
}

// ── The term table, read for names ───────────────────────────────────────────

// Per loaded table and scale: the spellings (names and synonyms, normalised)
// of that scale's rows, how many words the longest one has, and the one-word
// spellings longest first (for the term-inside-a-word check). A WeakMap on the
// table object, so a reload of the table starts a fresh index.
const indexCache = new WeakMap();
function scaleIndex(terms, scale) {
  let byScale = indexCache.get(terms);
  if (!byScale) { byScale = new Map(); indexCache.set(terms, byScale); }
  const cacheKey = scale || 'any';
  if (byScale.has(cacheKey)) return byScale.get(cacheKey);
  const keys = new Map();
  for (const [key, rows] of terms.byKey) {
    const own = scale ? rows.filter((r) => r.scale === scale) : rows;
    if (own.length) keys.set(key, own);
  }
  let maxWords = 1;
  for (const row of terms.byId.values()) {
    if (scale && row.scale !== scale) continue;
    for (const s of [row.name, ...(row.synonyms || [])]) {
      maxWords = Math.max(maxWords, (String(s || '').match(WORD_RX) || []).length);
    }
  }
  const single = [...keys.entries()]
    .filter(([k]) => !k.includes(' ') && k.length >= 3)
    .map(([key, rows]) => ({ key, name: rows[0].name }))
    .sort((a, b) => b.key.length - a.key.length);
  const index = { keys, maxWords, single };
  byScale.set(cacheKey, index);
  return index;
}

/**
 * The words of a name, each with its key in the table's fold — through the
 * spellings the style guard already knows ("Suess" is süß, the observed
 * "Troken" is trocken: utils/styleTerms SWEETNESS_ALIASES).
 */
function wordsOf(text) {
  return [...text.matchAll(WORD_RX)].map((m) => {
    const key = normalizeSweetnessTerm(m[0]);
    return { text: m[0], start: m.index, end: m.index + m[0].length, key: SWEETNESS_ALIASES.get(key) || key };
  });
}

/**
 * The spellings of the scale's terms that stand in the name as words of their
 * own, longest first, never overlapping. A span of several words counts only
 * when spaces or dashes join them, and matches its spelling either way it is
 * folded ("Extra-Brut" → "extrabrut", or word by word → "extra brut"). A word
 * the fold empties (another script, "Ø") is never part of a span.
 */
function standaloneHits(text, words, index) {
  const taken = new Array(words.length).fill(false);
  const hits = [];
  for (let len = Math.min(index.maxWords, words.length); len >= 1; len -= 1) {
    for (let i = 0; i + len <= words.length; i += 1) {
      const span = words.slice(i, i + len);
      if (span.some((w, n) => taken[i + n] || !w.key)) continue;
      if (span.slice(1).some((w, n) => !TERM_GAP_RX.test(text.slice(span[n].end, w.start)))) continue;
      const first = span[0]; const last = span[len - 1];
      const spellings = [normalizeSweetnessTerm(text.slice(first.start, last.end)), span.map((w) => w.key).join(' ')];
      const key = spellings.find((k) => k && index.keys.has(k));
      if (!key) continue;
      for (let n = 0; n < len; n += 1) taken[i + n] = true;
      hits.push({ firstWord: i, lastWord: i + len - 1, start: first.start, end: last.end, text: text.slice(first.start, last.end), key });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * A one-word term inside a longer word of the name ("Secco" in "Prosecco"), as
 * an ambiguity, or null. A Prädikat ("Trockenbeerenauslese") is a word of its
 * own and is skipped.
 */
function insideWord(words, index) {
  for (const w of words) {
    if (!w.key || statedStyle(w.text).pradikat.size) continue;
    const hit = index.single.find((s) => s.key.length < w.key.length && w.key.includes(s.key));
    if (hit) return ambiguity('inside_word', `${quote(hit.name)} sits inside the word ${quote(w.text)}; not read as the label sweetness`);
  }
  return null;
}

const ambiguity = (kind, detail) => ({ reason: 'name_ambiguous', kind, detail: clip(detail) });

/** What stands between two words of the name (or the name's edge). */
const gapBefore = (text, words, hit) => text.slice(hit.firstWord > 0 ? words[hit.firstWord - 1].end : 0, hit.start);
const gapAfter = (text, words, hit) => text.slice(hit.end, hit.lastWord + 1 < words.length ? words[hit.lastWord + 1].start : text.length);

/** Why a hit, read in its neighbourhood, is not the label term — or null. */
function neighbourhoodDoubt(text, words, hit, placeFolds) {
  const before = hit.firstWord > 0 ? words[hit.firstWord - 1] : null;
  const after = hit.lastWord + 1 < words.length ? words[hit.lastWord + 1] : null;
  const gapB = gapBefore(text, words, hit);
  const gapA = gapAfter(text, words, hit);
  const joined = (gap) => gap && TERM_GAP_RX.test(gap);
  if ((before && MODIFIERS.has(before.key) && joined(gapB)) || (after && MODIFIERS.has(after.key) && joined(gapA))) {
    return ambiguity('modifier', `${quote(hit.text)} stands beside ${quote((before && MODIFIERS.has(before.key) ? before : after).text)}, which changes it; not read as the label sweetness`);
  }
  if ((before && GLUE_RX.test(gapB)) || (after && GLUE_RX.test(gapA))) {
    return ambiguity('glued_word', `${quote(hit.text)} is joined to the next word; not read as the label sweetness`);
  }
  const fold = ` ${normalizeSweetnessTerm(hit.text)} `;
  if (placeFolds.some((p) => p.includes(fold))) {
    return ambiguity('place_word', `${quote(hit.text)} is also part of the wine's appellation, region or producer; not read as the label sweetness`);
  }
  return null;
}

/** The end of `s` without trailing space and dangling separators (linear). */
function stripTrailingSeps(s) {
  let i = s.length;
  for (;;) {
    while (i > 0 && isSpace(s[i - 1])) i -= 1;
    if (i > 0 && ATTACHED_SEPS.has(s[i - 1])) { i -= 1; continue; }
    let j = i;
    while (j > 0 && SPACED_SEPS.has(s[j - 1])) j -= 1;
    if (j < i && (j === 0 || isSpace(s[j - 1]))) { i = j; continue; }
    return s.slice(0, i);
  }
}

/** The start of `s` without leading space and dangling separators (linear). */
function stripLeadingSeps(s) {
  let i = 0;
  for (;;) {
    while (i < s.length && isSpace(s[i])) i += 1;
    if (i < s.length && ATTACHED_SEPS.has(s[i])) { i += 1; continue; }
    let j = i;
    while (j < s.length && SPACED_SEPS.has(s[j])) j += 1;
    if (j > i && (j === s.length || isSpace(s[j]))) { i = j; continue; }
    return s.slice(i);
  }
}

/**
 * Cut [start, end) out of a name and tidy what the cut leaves: the space, a
 * dangling separator, an emptied bracket or quote pair. A dash that glues the
 * word to a neighbour goes with it ("Riesling-trocken" → "Riesling"); a dash
 * glued inside another word stays ("-S-"). Linear in the length of the name:
 * no pattern that backtracks over a long run of spaces.
 */
function cutSpan(text, start, end) {
  if (start > 1 && isDash(text[start - 1]) && !isSpace(text[start - 2])) start -= 1;
  else if (end + 1 < text.length && isDash(text[end]) && !isSpace(text[end + 1])) end += 1;
  let left = text.slice(0, start).trimEnd();
  let right = text.slice(end).trimStart();
  const open = left.slice(-1);
  if (OPENERS.has(open) && right[0] === PAIRS[open]) {
    left = left.slice(0, -1).trimEnd();
    right = right.slice(1).trimStart();
  }
  if (OPENERS.has(left.slice(-1))) return left + stripLeadingSeps(right);
  if (CLOSERS.has(right[0])) return stripTrailingSeps(left) + right;
  if (!right) return stripTrailingSeps(left);
  if (!left) return stripLeadingSeps(right);
  const rightBare = stripLeadingSeps(right);
  if (rightBare !== right && /[,;:/|·\p{Pd}−]$/u.test(left)) return `${left} ${rightBare}`;
  if (ATTACHED_SEPS.has(right[0])) return `${left}${right}`;
  return `${left} ${right}`;
}

/** A word made of punctuation only — what a cut must not leave at an edge of the name. */
const bareToken = (t) => t && !/[\p{L}\p{N}]/u.test(t) && !OPENERS.has(t) && !CLOSERS.has(t);

/**
 * Read the label sweetness word out of a wine NAME, on a table the caller
 * loaded (sync). Returns { name, term, ambiguous }:
 *
 *   term       the row the name states as a word of its own, or null;
 *   name       the name without that word (separators tidied), or the name
 *              unchanged when nothing was read, or when no letter would be
 *              left ("Brut", "Brut 2012": the word is what calls the wine);
 *   ambiguous  null, or { reason: 'name_ambiguous', kind, detail } when the
 *              name holds a term that is NOT read — kind:
 *                english_word  only the English "dry" / "sweet" (Dry Creek,
 *                              Sweet Cheeks: utils/styleTerms
 *                              NAME_AMBIGUOUS_WORDS);
 *                two_terms     two terms, or one term twice ("Brut de Brut");
 *                not_at_end    a still-wine term that is not the last word
 *                              ("Dolce Vita"); a sparkling term is read
 *                              anywhere, the dosage words leave every
 *                              sparkling name;
 *                modifier      beside a word that changes it ("Semi-Secco",
 *                              "halb trocken", "Brut Zéro Dosage");
 *                glued_word    joined to a neighbour by / . or ' ("Demi/Sec");
 *                place_word    the word also stands in the wine's appellation,
 *                              region or producer ("Arroyo Seco");
 *                untidy_cut    the cut would leave punctuation at an edge of
 *                              the name ("Brut & Rosé");
 *                inside_word   a term inside a longer word ("Prosecco");
 *                no_scale      the wine has no type, so the scale is unknown;
 *                too_long      a name over 300 characters is not read.
 *
 * `scale` is the wine's (sweetnessOps.scaleForType): false (fortified, not a
 * wine) reads nothing. `keep` is the wine's sweetnessInName: the word IS the
 * name, so nothing is removed and nothing is read from it. `places` are the
 * wine's appellation, region and producer as text. Matching is by whole
 * words, names and synonyms, casing, ß and accents folded the way the table
 * folds them (normalizeSweetnessTerm). The switch is not read here.
 */
function extractLoaded(terms, name, { scale = null, keep = false, countryId = null, places = [] } = {}) {
  const text = typeof name === 'string' ? name : '';
  const none = { name: text, term: null, ambiguous: null };
  if (scale === false || keep || !text.trim() || !terms || terms.empty) return none;
  if (text.length > NAME_MAX) return { ...none, ambiguous: ambiguity('too_long', `the name is over ${NAME_MAX} characters; not read`) };
  const index = scaleIndex(terms, scale);
  const words = wordsOf(text);
  const all = standaloneHits(text, words, index);
  if (!all.length) return { ...none, ambiguous: insideWord(words, index) };
  // The English words are ordinary name words beside a real term, and only a
  // clue when they stand alone (the style guard reads names the same way).
  const hits = all.filter((h) => !NAME_AMBIGUOUS_WORDS.has(h.key));
  if (!hits.length) {
    return { ...none, ambiguous: ambiguity('english_word', `${quote(all[0].text)} may be an ordinary English word of the name; not read as the label sweetness`) };
  }
  if (scale === null) {
    return { ...none, ambiguous: ambiguity('no_scale', `the wine has no type, so the scale of ${quote(hits[0].text)} is unknown`) };
  }
  for (const h of hits) h.row = resolveLoaded(terms, h.key, { scale, countryId });
  if (hits.length > 1) {
    return { ...none, ambiguous: ambiguity('two_terms', `the name states a sweetness term more than once (${hits.slice(0, 3).map((h) => quote(h.text)).join(', ')}); nothing read`) };
  }
  const hit = hits[0];
  const placeFolds = (Array.isArray(places) ? places : [])
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => ` ${normalizeSweetnessTerm(p)} `);
  const doubt = neighbourhoodDoubt(text, words, hit, placeFolds);
  if (doubt) return { ...none, ambiguous: doubt };
  if (scale === 'still' && hit.lastWord !== words.length - 1) {
    return { ...none, ambiguous: ambiguity('not_at_end', `${quote(hit.text)} is not the last word of the name; not read as the label sweetness`) };
  }
  const out = cutSpan(text, hit.start, hit.end).trim();
  const edges = out.split(/\s+/);
  if (bareToken(edges[0]) || bareToken(edges[edges.length - 1])) {
    return { ...none, ambiguous: ambiguity('untidy_cut', `taking ${quote(hit.text)} out would leave punctuation at the edge of the name; nothing read`) };
  }
  return { name: /\p{L}/u.test(out) ? out : text, term: hit.row, ambiguous: null };
}

/**
 * The same, loading the term table first (an empty table reads nothing). No
 * REST or MCP caller yet. Returns { name, term, ambiguous } as extractLoaded.
 */
async function extractFromName(name, opts = {}) {
  return extractLoaded(await loadTerms(), name, opts);
}

// ── The write rule ───────────────────────────────────────────────────────────

/**
 * The terms a wine of this scale (and country) may carry, for a refusal. The
 * limit is above the seed's largest scale, so a curator sees every choice.
 */
function knownTermsHint(terms, scale, countryId, limit = 60) {
  const names = [...new Set([...terms.byId.values()]
    .filter((r) => (!scale || r.scale === scale)
      && (!r.country || (countryId && String(idOf(r.country)) === String(countryId))))
    .map((r) => r.name))]
    .sort((a, b) => a.localeCompare(b));
  return `${names.slice(0, limit).join(', ')}${names.length > limit ? ', …' : ''}`;
}

/** A word, or a term row id, to its row on the wine's scale; else why not. */
function termFor(terms, word, { scale, countryId }) {
  if (ID_RX.test(word) && terms.byId.has(word.toLowerCase())) {
    const row = terms.byId.get(word.toLowerCase());
    return !scale || row.scale === scale ? { row } : { otherScale: row.scale };
  }
  const row = resolveLoaded(terms, word, { scale, countryId });
  if (row) return { row };
  const rows = terms.byKey.get(normalizeSweetnessTerm(word)) || [];
  if (!rows.length) return {};
  const scales = [...new Set(rows.map((r) => r.scale))];
  return scale ? { otherScale: scales.find((s) => s !== scale) || scales[0] } : { bothScales: true };
}

/** Every term the name states as words of its own, the English words included. */
function nameHits(terms, name, { scale, keep, countryId }) {
  if (keep || !scale || terms.empty) return [];
  const text = typeof name === 'string' ? name : '';
  if (text.length > NAME_MAX) return [];
  return standaloneHits(text, wordsOf(text), scaleIndex(terms, scale))
    .map((h) => ({ ...h, row: resolveLoaded(terms, h.key, { scale, countryId }) }));
}

/** The terms the name states as words of its own (the English words aside). */
function nameTerms(terms, name, opts) {
  return nameHits(terms, name, opts).filter((h) => !NAME_AMBIGUOUS_WORDS.has(h.key));
}

/** Why this term cannot sit on a wine whose Prädikat is sweet by law, or null. */
function pradikatContradiction(row, wineLike) {
  if (!DRY_SIDE_BANDS.has(row.band)) return null;
  const tier = sweetByLawPradikat(wineLike);
  return tier ? `${tier} is sweet by law, but the term ${quote(row.name)} is ${row.band}` : null;
}

/** Set the review marker; the same reason keeps the first `since`. */
function mark(target, result, reason, detail) {
  const prev = target.sweetnessReview;
  const since = prev && prev.reason === reason && prev.since ? prev.since : new Date();
  target.sweetnessReview = { reason, detail: clip(detail), since };
  result.review = target.sweetnessReview;
  return result;
}

const refuse = (reason, word, message) => ({ ok: false, code: 'invalid_input', reason, unresolved: word ? [echo(word)] : [], message });

/**
 * Whether this write sets `field`: a value passed that differs from the
 * target's own, or — on a document — a field already set on it in this
 * write, or every field of a new one. A value equal to the target's own is
 * not a change: call the rule before assigning the fields it reads.
 */
function sets(target, field, value) {
  if (isDoc(target) && (target.isNew || target.isModified(field))) return true;
  return value !== undefined && value !== target[field];
}

/** The wine's appellation, region and producer, as text a name word is checked against. */
function placesOf(target) {
  const region = target.region && typeof target.region === 'object' && typeof target.region.name === 'string' ? target.region.name : null;
  return [target.appellation, region, target.producer].filter((p) => typeof p === 'string' && p.trim());
}

/**
 * THE write rule for a wine's label sweetness. Sets `labelSweetness` (a term
 * row id), and — when the word leaves it — `name`, on `target` (a
 * WineDefinition document or the plain fields of one being built); sets
 * `sweetnessReview` when a curator must look. No REST or MCP caller yet.
 *
 * Input: `labelSweetness` — the term as printed, a term row id or an ObjectId
 * (anything else is an unknown word); undefined leaves the field alone, null
 * or '' clears it. `name`, `type`, `countryId` default to the target's own;
 * pass them when the same write sets them, and call the rule BEFORE assigning
 * them (a value equal to the target's own is not a change). `type: null`
 * means "no type". `strict` (a curator at a form or tool) refuses what
 * lenient (a member, a scan, an import, a peer) drops and marks.
 *
 *   explicit term  resolved on the wine's scale (and country). Unknown word:
 *                  strict → refused with the known terms, lenient → dropped,
 *                  marker unknown_term (type_mismatch when the word is a term
 *                  of the other scale). Fortified / not wine: strict →
 *                  refused, lenient → dropped. A different term in the name,
 *                  or a dry-side term on a Prädikat sweet by law: strict →
 *                  refused (term_contradiction), lenient → nothing written,
 *                  marker term_contradiction. Else written; with the switch
 *                  on, the same word leaves the name.
 *   a new type     the stored term moves to the same word on the new scale
 *                  (trocken → the Sekt "Trocken"); when that scale has no
 *                  such word, or the wine is now fortified: strict → refused
 *                  (type_mismatch), lenient → kept and marked type_mismatch.
 *   no term given  switch off: nothing more. Switch on, and the write sets
 *                  the name or the type: the name's word moves into the field
 *                  (extractLoaded), unless the wine is marked sweetnessInName;
 *                  an ambiguous name is marked name_ambiguous (a term inside
 *                  a word is only reported, and a name whose words are all
 *                  the stored term is settled); a name word that differs from
 *                  the stored term, or contradicts the Prädikat: strict →
 *                  refused, lenient → marked term_contradiction, nothing moves.
 *
 * A document loaded without labelSweetness is refused (not_loaded): the rule
 * would read it as "no term".
 *
 * Returns { ok: true, changed, term, name, dropped, review, ambiguous } —
 * `changed` when labelSweetness or name was written, `term` a copy of the row
 * written (null when none), `name` the new name when the word left it (else
 * null), `dropped` the words not written, `review` the marker set (else null),
 * `ambiguous` what the name reading could not decide; save when `changed` or
 * `review` — or { ok: false, code: 'invalid_input', reason, unresolved,
 * message } on a refusal (reason: unknown_term | type_mismatch | no_scale |
 * term_contradiction | not_loaded), when nothing is written. A reason code for
 * the caller, not an HTTP body: the caller answers in its own words (REST
 * error body, MCP failure).
 */
async function assignSweetness(target, { labelSweetness, name, type, countryId = null, strict = false } = {}) {
  if (isDoc(target) && !target.isNew && !target.isSelected('labelSweetness') && !target.isModified('labelSweetness')) {
    return refuse('not_loaded', '', 'The wine was loaded without its label sweetness; load the field before writing it.');
  }
  const terms = await loadTerms();
  const result = { ok: true, changed: false, term: null, name: null, dropped: [], review: null, ambiguous: null };
  const extract = constants.SWEETNESS_EXTRACT_FROM_NAME === true;
  const nonWine = target.nonWine === true;
  const typeSet = sets(target, 'type', type);
  const nameSet = sets(target, 'name', name);
  const wineType = type !== undefined ? type : target.type;
  const scale = scaleForType(wineType, { nonWine });
  const currentName = typeof name === 'string' ? name : (typeof target.name === 'string' ? target.name : '');
  const keep = target.sweetnessInName === true;
  const cid = idOf(countryId) || idOf(target.country) || null;
  const wineLike = { name: currentName, classifications: target.classifications, classification: target.classification };
  const places = placesOf(target);

  // A contradiction: refused on the strict path, marked on the lenient one.
  const contradiction = (word, detail) => {
    if (strict) return refuse('term_contradiction', word, `The term was not written: ${detail}.`);
    if (word) result.dropped.push(echo(word));
    return mark(target, result, 'term_contradiction', detail);
  };
  const moveWordOutOfName = (row) => {
    if (!extract) return;
    const read = extractLoaded(terms, currentName, { scale, keep, countryId: cid, places });
    result.ambiguous = read.ambiguous;
    if (read.term && sameId(read.term._id, row._id) && read.name !== currentName) {
      target.name = read.name; result.name = read.name; result.changed = true;
    }
  };
  const writeTerm = (row) => {
    if (!sameId(target.labelSweetness, row._id)) { target.labelSweetness = row._id; result.changed = true; }
    result.term = { ...row };
  };

  if (labelSweetness !== undefined) {
    const given = labelSweetness == null ? { word: '' } : wordOf(labelSweetness);
    const word = given.word;
    if (!word && !given.invalid) {
      if (target.labelSweetness != null) { target.labelSweetness = null; result.changed = true; }
      return result;
    }
    if (scale === false) {
      if (strict) {
        return refuse('no_scale', word, nonWine
          ? `A drink that is not wine has no label sweetness; ${quote(word)} was not set.`
          : `Fortified wines have no label sweetness yet; ${quote(word)} was not set.`);
      }
      result.dropped.push(echo(word));
      return result;
    }
    // No table (no database connection, nothing seeded): nothing resolves.
    if (terms.empty) { result.dropped.push(echo(word)); return result; }

    const found = given.invalid ? {} : termFor(terms, word, { scale, countryId: cid });
    if (!found.row) {
      const reason = found.otherScale || found.bothScales ? 'type_mismatch' : 'unknown_term';
      if (strict) {
        let message;
        if (found.bothScales) message = `${quote(word)} is a term of both scales; the wine's type decides which. Set the type first.`;
        else if (found.otherScale) message = `${quote(word)} is a term for ${scaleWords(found.otherScale)}, and this is ${scaleWords(scale)}. Known terms here: ${knownTermsHint(terms, scale, cid)}.`;
        else message = `${quote(word)} is not a label sweetness term for ${scaleWords(scale)}. Known terms here: ${knownTermsHint(terms, scale, cid)}. A term the list lacks is added under Admin → Taxonomy → Sweetness terms.`;
        return refuse(reason, word, message);
      }
      result.dropped.push(echo(word));
      let detail;
      if (found.bothScales) detail = `${quote(word)} was given, and the wine has no type to say which scale it is on`;
      else if (found.otherScale) detail = `${quote(word)} was given, a term for ${scaleWords(found.otherScale)}; the wine is ${scaleWords(scale)}`;
      else detail = `${quote(word)} was given, a word the sweetness term table does not have`;
      return mark(target, result, reason, detail);
    }
    const row = found.row;
    // The name is read on the term's own scale when the wine has no type.
    const inName = nameTerms(terms, currentName, { scale: scale || row.scale, keep, countryId: cid })
      .find((h) => h.row && !sameId(h.row._id, row._id));
    if (inName) return contradiction(word, `the name states ${quote(inName.text)}, the term given is ${quote(row.name)}`);
    const byLaw = pradikatContradiction(row, wineLike);
    if (byLaw) return contradiction(word, byLaw);
    writeTerm(row);
    moveWordOutOfName(row);
    return result;
  }

  // A new type: the stored term follows it to the same word on the new scale.
  // Decided here, written last, so a refusal below leaves the wine untouched.
  let moved = null;
  if (typeSet && target.labelSweetness != null && !terms.empty) {
    const storedRow = terms.byId.get(String(idOf(target.labelSweetness)));
    if (storedRow && scale !== null && storedRow.scale !== scale) {
      moved = scale === false ? null : resolveLoaded(terms, storedRow.name, { scale, countryId: cid });
      if (!moved) {
        const detail = scale === false
          ? `the wine is now ${nonWine ? 'not a wine' : 'fortified'}, and keeps the term ${quote(storedRow.name)}`
          : `the term ${quote(storedRow.name)} is for ${scaleWords(storedRow.scale)}; the wine is now ${scaleWords(scale)}`;
        if (strict) return refuse('type_mismatch', storedRow.name, `The type was not changed: ${detail}. Clear or change the term first.`);
        return mark(target, result, 'type_mismatch', detail);
      }
    }
  }
  const storedNow = moved ? moved._id : target.labelSweetness;
  const finish = () => { if (moved) writeTerm(moved); return result; };

  // No term given: only the switch reads one off a name, and only off a name
  // (or a scale) this write sets — a write that touches neither leaves the
  // name to the migration and the curators.
  if (!extract || scale === false || (!nameSet && !typeSet)) return finish();
  const read = extractLoaded(terms, currentName, { scale, keep, countryId: cid, places });
  if (read.ambiguous) {
    result.ambiguous = read.ambiguous;
    // Settled: every term the name states is the one the record holds.
    const named = nameHits(terms, currentName, { scale, keep, countryId: cid });
    const settled = storedNow != null && named.length > 0 && named.every((h) => h.row && sameId(h.row._id, storedNow));
    if (settled || !MARKED_AMBIGUITIES.has(read.ambiguous.kind)) return finish();
    finish();
    return mark(target, result, 'name_ambiguous', read.ambiguous.detail);
  }
  if (!read.term) return finish();
  // Lenient: the new type's move still applies; only the name word stays put.
  const held = (detail) => { if (!strict) finish(); return contradiction('', detail); };
  if (storedNow != null && !sameId(storedNow, read.term._id)) {
    const storedName = (terms.byId.get(String(idOf(storedNow))) || {}).name || 'another term';
    return held(`the name states ${quote(read.term.name)}, the record states ${quote(storedName)}`);
  }
  const byLaw = pradikatContradiction(read.term, wineLike);
  if (byLaw) return held(byLaw);
  writeTerm(read.term);
  if (read.name !== currentName) { target.name = read.name; result.name = read.name; result.changed = true; }
  return result;
}

module.exports = {
  extractFromName, extractLoaded, assignSweetness,
};
