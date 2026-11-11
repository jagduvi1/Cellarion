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
 *   assignSweetnessStyle — THE write rule for sweetnessStyle, the term a wine
 *     is known by when its label prints none: never without the page that
 *     names it, a regulated term only from the producer, the label's own term
 *     first, producer before trade.
 *
 * Kept apart from sweetnessOps because every read surface imports that module
 * and none of them needs this one: the rule has its own vocabulary (the
 * ambiguity kinds, the review markers, the switch, the verdicts), and a reader looking for
 * what happens when a term is written finds all of it here. How a name is
 * split into words, and which characters join the words of one term, is
 * utils/normalize (sweetnessWords): the display name and the slug read names
 * the same way, so they never repeat a term the rule reads in a name.
 *
 * The Registry Bridge copy calls assignSweetnessStyle (services/registryBridge).
 * No other write path calls either rule yet.
 */
const mongoose = require('mongoose');
const constants = require('../config/constants');
const Region = require('../models/Region');
const { normalizeSweetnessTerm, sweetnessWords, sweetnessSpanKeys, SWEETNESS_TERM_GAP_RX } = require('../utils/normalize');
const { NAME_AMBIGUOUS_WORDS, statedStyle, sweetByLawPradikat } = require('../utils/styleTerms');
const { loadTerms, resolveLoaded, scaleForType } = require('./sweetnessOps');
const { isSafeUrl } = require('../utils/sanitize');
const { URL_MAX } = require('./proposalFields');

// Glue that makes one word of two ("Demi/Sec", "Brut.Rosé", "L'Extra Brut"):
// a term attached to a neighbour by it is not read.
const GLUE_RX = /^[/.'’`´]+$/u;
const isSpace = (ch) => /^\s$/u.test(ch || '');
const isWordChar = (ch) => /^[\p{L}\p{M}\p{N}]$/u.test(ch || '');
const hasWordChar = (s) => /[\p{L}\p{M}\p{N}]/u.test(s);
// A dash, the minus sign, the soft hyphen or a zero-width character: what
// glues a term to a neighbour ("Riesling-trocken", "Pinot-Brut-Rosé").
const isJoiner = (ch) => /^[\p{Pd}\u2212\u00AD\u200B-\u200D]$/u.test(ch || '');
const allOf = (s, test) => s.length > 0 && [...s].every(test);
// Punctuation that sits against the word before it ("Riesling trocken." →
// "Riesling."): left touching a term, it stays on the word before.
const ATTACHED_SEPS = new Set([',', ';', ':', '.']);
// A separator token standing between two spaces ("Riesling - trocken"): left
// at an edge of the name by the cut, it goes with the term.
const SPACED_SEPS = new Set(['-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212', '/', '|', '·']);
// What the neighbour of a term at an edge of the name may lose: a comma,
// colon, semicolon or dash that only parted it from the term ("Riesling,
// trocken", "Riesling- trocken"). Never a period: "R.D.", "b.A." and "N.V."
// end in one.
const EDGE_SEPS = new Set([',', ';', ':']);
const isEdgeSep = (ch) => EDGE_SEPS.has(ch) || isJoiner(ch);
// Brackets and quotes whose pair the cut empties ("Riesling (trocken)"), each
// opener with the closers that end it ("„…“" and "„…”" are both written).
const PAIRS = { '(': ')', '[': ']', '"': '"', '“': '”', '„': '“”', '«': '»', '»': '«', '‹': '›', '›': '‹' };
const OPENERS = new Set(Object.keys(PAIRS));
const CLOSERS = new Set(Object.values(PAIRS).join(''));
const closes = (open, close) => !!open && !!close && (PAIRS[open] || '').includes(close);
// A bracket that never closes, or never opens, standing against a neighbour
// the cut leaves behind ("Cuvée( Brut )Rosé"): no tidy cut leaves one there.
const HARD_OPENERS = new Set(['(', '[', '{', '„']);
const HARD_CLOSERS = new Set([')', ']', '}']);
// What a tidy cut never adds to a name (counted against the name it was
// given): an empty pair, a bracket with a space on its inner side, a
// separator beside a comma, closing and opening punctuation glued together,
// doubled punctuation. Each pattern scans in linear time.
const CUT_FAULTS = [
  /\(\s*\)|\[\s*\]|«\s*»|„\s*[“”]|“\s*”|‹\s*›|"\s*"(?![\p{L}\p{N}])/gu,
  /[(\[«„‹]\s|\s[)\]»›]/gu,
  /[,;:]\s+[-\u2010-\u2015\u2212/|·&+]+(?=\s|$)|(?:^|\s)[-\u2010-\u2015\u2212/|·&+]+\s+[,;:]/gu,
  /["”“»)\]]["“„«(\[]/gu,
  /[,;:][,;:.]|\.[,;:]/gu,
];
const countOf = (text, rx) => { rx.lastIndex = 0; let n = 0; while (rx.exec(text)) n += 1; return n; };
const charCount = (text, ch) => { let n = 0; for (const c of text) if (c === ch) n += 1; return n; };
/** Whether a cut made the name untidier than it was: a fault it did not have, or brackets it left unbalanced. */
function cutLeftAFault(text, out) {
  if (CUT_FAULTS.some((rx) => countOf(out, rx) > countOf(text, rx))) return true;
  for (const [o, c] of [['(', ')'], ['[', ']'], ['«', '»']]) {
    if (charCount(out, o) - charCount(out, c) !== charCount(text, o) - charCount(text, c)) return true;
  }
  return charCount(out, '"') % 2 !== charCount(text, '"') % 2;
}
// Words that change the term beside them: "Semi-Secco" is not secco, "halb
// trocken" not trocken, "Ultra Brut" not Brut, "Brut Zéro Dosage" not Brut.
// A hit next to one is not read, nor a hit two words before "dosage" ("Brut
// Sans Dosage"; "Brut Sans Année" is Brut).
const MODIFIERS = new Set(['semi', 'demi', 'halb', 'half', 'meio', 'medio', 'extra', 'ultra', 'zero', 'nature', 'dosage']);
const DOSAGE = 'dosage';
const ID_RX = /^[0-9a-f]{24}$/i;
// A name longer than this is not read for a term: no label prints one, and
// the reading must stay cheap on whatever a caller hands in.
const NAME_MAX = 300;

// The sweetnessReview.detail limit (models/WineDefinition), and the longest a
// word sent by a caller is echoed back (a message, a marker, `unresolved`).
const DETAIL_MAX = 300;
const ECHO_MAX = 60;
const clip = (s) => String(s).slice(0, DETAIL_MAX);
/** A caller's word as one short, quoted line: no line breaks, no markup, no inner double quote. */
function quote(s) {
  const flat = String(s == null ? '' : s).replace(/[\p{C}\s]+/gu, ' ').replace(/[<>]/g, '').replace(/"/g, "'").trim();
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
/** A table row handed to a caller: a copy, its lists too, so the cached table cannot be changed through it. */
const copyRow = (row) => (row ? {
  ...row,
  ...(Array.isArray(row.synonyms) ? { synonyms: [...row.synonyms] } : {}),
  ...(Array.isArray(row.normalizedSynonyms) ? { normalizedSynonyms: [...row.normalizedSynonyms] } : {}),
} : row);

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

/** Two term rows — or a row and a populated ref read without its id — are the same term. */
function sameTerm(a, b) {
  if (!a || !b) return false;
  if (a._id != null && b._id != null) return String(a._id) === String(b._id);
  return a.scale === b.scale && normalizeSweetnessTerm(a.name) === normalizeSweetnessTerm(b.name);
}

/**
 * A stored term ref, however it was loaded — an id (string or ObjectId), or a
 * populated row with its id or without it (the write tools load the term as
 * 'name band scale regulated -_id'; then it is found by name and scale) — as a
 * row of the loaded table. Null for none; the ref itself for a populated row
 * the table does not hold; 'unresolved' for an id the table does not hold.
 */
function storedRow(terms, ref) {
  if (ref == null) return null;
  if (typeof ref === 'object' && !(ref instanceof mongoose.Types.ObjectId) && typeof ref.name === 'string' && ref.name) {
    const byId = ref._id != null ? terms.byId.get(String(ref._id)) : null;
    return byId || (terms.byKey.get(normalizeSweetnessTerm(ref.name)) || [])
      .find((r) => r.name === ref.name && (!ref.scale || r.scale === ref.scale)) || ref;
  }
  return terms.byId.get(String(idOf(ref))) || 'unresolved';
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
    for (const s of [row.name, ...(row.synonyms || [])]) maxWords = Math.max(maxWords, sweetnessWords(s).length);
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
 * The spellings of the scale's terms that stand in the name as words of their
 * own, longest first, never overlapping. A span of several words counts only
 * when term gaps join them (utils/normalize sweetnessSpanKeys: spaces, dashes,
 * the soft hyphen, zero-width characters), and matches its spelling either
 * way it is folded ("Extra-Brut" → "extrabrut", or word by word → "extra
 * brut"). A word the fold empties (another script, "Ø") is never part of one.
 */
function standaloneHits(text, words, index) {
  const taken = new Array(words.length).fill(false);
  const hits = [];
  for (let len = Math.min(index.maxWords, words.length); len >= 1; len -= 1) {
    for (let i = 0; i + len <= words.length; i += 1) {
      if (taken.slice(i, i + len).some(Boolean)) continue;
      const keys = sweetnessSpanKeys(text, words, i, len);
      const key = keys && keys.find((k) => k && index.keys.has(k));
      if (!key) continue;
      for (let n = 0; n < len; n += 1) taken[i + n] = true;
      const first = words[i]; const last = words[i + len - 1];
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

/**
 * The wine's appellation, region and producer as word keys (" arroyo seco "),
 * so a place written with a dash or a double space still counts. Takes a
 * string, or a list of strings or { name } objects.
 */
function placeKeysOf(places) {
  const keys = [];
  for (const p of Array.isArray(places) ? places : [places]) {
    const text = typeof p === 'string' ? p : (p && typeof p === 'object' && typeof p.name === 'string' ? p.name : '');
    const words = sweetnessWords(text).map((w) => w.fold).filter(Boolean);
    if (words.length) keys.push(` ${words.join(' ')} `);
  }
  return keys;
}

/** What stands between two words of the name (or the name's edge). */
const gapBefore = (text, words, hit) => text.slice(hit.firstWord > 0 ? words[hit.firstWord - 1].end : 0, hit.start);
const gapAfter = (text, words, hit) => text.slice(hit.end, hit.lastWord + 1 < words.length ? words[hit.lastWord + 1].start : text.length);

/** Why a hit, read in its neighbourhood, is not the label term — or null. */
function neighbourhoodDoubt(text, words, hit, placeKeys) {
  const before = hit.firstWord > 0 ? words[hit.firstWord - 1] : null;
  const after = hit.lastWord + 1 < words.length ? words[hit.lastWord + 1] : null;
  const gapB = gapBefore(text, words, hit);
  const gapA = gapAfter(text, words, hit);
  const joined = (gap) => gap && SWEETNESS_TERM_GAP_RX.test(gap);
  const next = after && hit.lastWord + 2 < words.length ? words[hit.lastWord + 2] : null;
  const modifier = (before && MODIFIERS.has(before.fold) && joined(gapB) && before)
    || (after && MODIFIERS.has(after.fold) && joined(gapA) && after)
    || (next && next.fold === DOSAGE && joined(gapA) && joined(text.slice(after.end, next.start)) && next);
  if (modifier) {
    return ambiguity('modifier', `${quote(hit.text)} stands beside ${quote(modifier.text)}, which changes it; not read as the label sweetness`);
  }
  if ((before && GLUE_RX.test(gapB)) || (after && GLUE_RX.test(gapA))) {
    return ambiguity('glued_word', `${quote(hit.text)} is joined to the next word; not read as the label sweetness`);
  }
  const own = ` ${words.slice(hit.firstWord, hit.lastWord + 1).map((w) => w.key).join(' ')} `;
  if (placeKeys.some((p) => p.includes(own))) {
    return ambiguity('place_word', `${quote(hit.text)} is also part of the wine's appellation, region or producer; not read as the label sweetness`);
  }
  return null;
}

/** Where the whitespace-delimited token ending at `to` starts. */
function tokenStart(s, to) { let i = to; while (i > 0 && !isSpace(s[i - 1])) i -= 1; return i; }
/** Where the whitespace-delimited token starting at `from` ends. */
function tokenEnd(s, from) { let i = from; while (i < s.length && !isSpace(s[i])) i += 1; return i; }

/** The last word of `s` without the separators that only parted it from a term after it. */
function dropTrailingSeps(s) {
  const from = tokenStart(s, s.length);
  if (isJoiner(s[from])) return s; // "-S-": a dash that opens the word is the word's own
  let i = s.length;
  while (i > from && isEdgeSep(s[i - 1])) i -= 1;
  return i < s.length && hasWordChar(s.slice(from, i)) ? s.slice(0, i) : s;
}

/** The first word of `s` without the separators that only parted it from a term before it. */
function dropLeadingSeps(s) {
  const to = tokenEnd(s, 0);
  if (isJoiner(s[to - 1])) return s;
  let i = 0;
  while (i < to && isEdgeSep(s[i])) i += 1;
  return i > 0 && hasWordChar(s.slice(i, to)) ? s.slice(i) : s;
}

/**
 * Cut [start, end) — the term — out of a name. Every letter and digit
 * outside the term stays, in order, and so does every other character except
 * these, which go with the term: the spaces beside it; one dash directly
 * against it ("Riesling-trocken" → "Riesling"; between two words it glued,
 * one stays: "Pinot-Brut-Rosé" → "Pinot-Rosé"); a bracket or quote pair it
 * fills, with the punctuation inside it ('Cuvée "Brut," Rosé' → "Cuvée Rosé";
 * "Riesling ( trocken )" → "Riesling"); a separator token it would leave at an
 * edge of the name ("Riesling - trocken"), double ("Cuvée & Brut & Rosé" →
 * "Cuvée & Rosé"), or leave beside a comma ("Cuvée, Brut - Rosé" → "Cuvée,
 * Rosé"); a comma, colon, semicolon or dash that parted the term at an edge
 * from its neighbour ("Riesling, trocken", "Riesling,trocken"); and a period
 * after the term that the word before already ends in ("N.V. Brut." →
 * "N.V."). An opening quote before the term moves to the next word, closing
 * punctuation after it to the word before ("Riesling trocken." →
 * "Riesling."); a quote that belongs to a neighbour keeps its space
 * ('Sekt "Alte Reben" Brut Rosé'). Returns null for any other shape, and for
 * any result untidier than the name it was given (cutLeftAFault) — the caller
 * reads nothing (untidy_cut). Linear in the length of the name: index loops,
 * and patterns that do not backtrack.
 */
function cutSpan(text, start, end) {
  // The punctuation touching the term, with no space between.
  let a = start; while (a > 0 && !isSpace(text[a - 1]) && !isWordChar(text[a - 1])) a -= 1;
  let b = end; while (b < text.length && !isSpace(text[b]) && !isWordChar(text[b])) b += 1;
  let touchL = text.slice(a, start);
  let touchR = text.slice(end, b);
  const gluedL = a > 0 && !isSpace(text[a - 1]);
  const gluedR = b < text.length && !isSpace(text[b]);
  // Pairs the term fills, with the punctuation between the term and the closer.
  let pl = touchL.length; let pr = 0;
  for (;;) {
    let k = pr;
    while (k < touchR.length && ATTACHED_SEPS.has(touchR[k])) k += 1;
    if (pl === 0 || k >= touchR.length || !closes(touchL[pl - 1], touchR[k])) break;
    pl -= 1; pr = k + 1;
  }
  touchL = touchL.slice(0, pl); touchR = touchR.slice(pr);
  // An opener left before the term and a closer after it do not belong together.
  if ([...touchL].some((c) => OPENERS.has(c)) && [...touchR].some((c) => CLOSERS.has(c))) return null;
  const atStart = !touchL && !text.slice(0, a).trim();
  const atEnd = !touchR && !text.slice(b).trim();
  // One dash directly against the term; one behind an emptied pair, or two,
  // may be a neighbour's own ("-S-") and is left to the untidy rule below. A
  // comma, colon or semicolon glued between the term and a word at an edge
  // only parted the two; between two words, one of two stays.
  const single = (t, test) => pr === 0 && t.length === 1 && test(t);
  const joinL = single(touchL, isJoiner) || (gluedL && atEnd && single(touchL, (c) => EDGE_SEPS.has(c)));
  const joinR = single(touchR, isJoiner) || (gluedR && atStart && single(touchR, (c) => EDGE_SEPS.has(c)));
  let joint = '';
  if (single(touchL, isJoiner) && single(touchR, isJoiner) && gluedL && gluedR) joint = touchR;
  else if (gluedL && gluedR && touchL === touchR && single(touchL, (c) => EDGE_SEPS.has(c))) { joint = touchR; touchL = ''; touchR = ''; }
  if (joinL) touchL = '';
  if (joinR) touchR = '';
  if (touchL && (gluedL || !allOf(touchL, (c) => OPENERS.has(c)))) return null;
  if (touchR && (gluedR || !allOf(touchR, (c) => CLOSERS.has(c) || ATTACHED_SEPS.has(c)))) return null;

  // At most one separator token on each side, between the term and its neighbour.
  const sepEndingAt = (to) => { const from = tokenStart(text, to); const tok = text.slice(from, to); return tok && !hasWordChar(tok) ? from : -1; };
  const sepStartingAt = (from) => { const to = tokenEnd(text, from); const tok = text.slice(from, to); return tok && !hasWordChar(tok) ? to : -1; };
  let l = a; while (l > 0 && isSpace(text[l - 1])) l -= 1;
  let sepL = '';
  const fromL = sepEndingAt(l);
  if (fromL >= 0) {
    sepL = text.slice(fromL, l);
    l = fromL; while (l > 0 && isSpace(text[l - 1])) l -= 1;
    if (sepEndingAt(l) >= 0) return null;
  }
  let r = b; while (r < text.length && isSpace(text[r])) r += 1;
  let sepR = '';
  const toR = sepStartingAt(r);
  if (toR >= 0) {
    sepR = text.slice(r, toR);
    r = toR; while (r < text.length && isSpace(text[r])) r += 1;
    if (sepStartingAt(r) >= 0) return null;
  }
  let left = text.slice(0, l);
  let right = text.slice(r);

  // A pair standing apart around the term ("Riesling « trocken »") is emptied;
  // any other bracket or quote in a separator token is not a separator.
  if (!touchL && !touchR && sepL.length === 1 && sepR.length === 1 && closes(sepL, sepR)) { sepL = ''; sepR = ''; }
  const bracketish = (sep) => [...sep].some((c) => OPENERS.has(c) || CLOSERS.has(c));
  if (bracketish(sepL) || bracketish(sepR)) return null;
  const spaced = (sep) => allOf(sep, (c) => SPACED_SEPS.has(c));
  if ((sepL && !left) || (sepR && !right)) return null;
  if (sepL && !right) { if (!spaced(sepL)) return null; sepL = ''; }
  if (sepR && !left) { if (!spaced(sepR)) return null; sepR = ''; }
  if (sepL && sepR) { if (sepL !== sepR) return null; sepR = ''; }
  if (!right) left = dropTrailingSeps(left);
  if (!left) right = dropLeadingSeps(right);

  // A separator after the term inside a bracket opened before it parted the
  // term from the next item: "Rosé (Brut, Magnum)" → "Rosé (Magnum)",
  // "Cuvée (Brut - Rosé)" → "Cuvée (Rosé)".
  if (touchL && allOf(touchR, (c) => ATTACHED_SEPS.has(c))) touchR = '';
  if (touchL && sepR && spaced(sepR) && isWordChar(right[0])) sepR = '';
  // A comma after the term beside a spaced separator before it: the separator
  // already parts the two neighbours ("Cuvée - Brut, Rosé" → "Cuvée - Rosé").
  if (sepL && allOf(touchR, (c) => EDGE_SEPS.has(c))) touchR = '';
  if (touchR) {
    if (!left) {
      if (!allOf(touchR, (c) => ATTACHED_SEPS.has(c))) return null;
    } else {
      // ...and one before a bracket the term closes: "(Magnum, Brut)" → "(Magnum)",
      // "(Rosé - Brut) Cuvée" → "(Rosé) Cuvée".
      if (CLOSERS.has(touchR[0]) && sepL && spaced(sepL) && isWordChar(left[left.length - 1])) sepL = '';
      if (CLOSERS.has(touchR[0]) && !sepL) left = dropTrailingSeps(left);
      if (sepL) return null;
      const last = left[left.length - 1];
      if (!isWordChar(last) && !CLOSERS.has(last)) {
        if (last !== touchR[0]) return null;
        touchR = touchR.slice(1);
      }
      left += touchR;
    }
  }
  if (touchL) {
    if (!right || sepR) return null;
    // The closer of that opener, after a space: the pair held only the term.
    if (touchL.length === 1 && closes(touchL, right[0])) right = right.slice(1).trimStart();
    else right = touchL + right;
  }
  if (left && HARD_OPENERS.has(left[left.length - 1])) return null;
  if (right && HARD_CLOSERS.has(right[0])) return null;
  let out;
  if (!left || !right) out = left || right;
  else if (sepL || sepR) {
    // A kept separator beside a comma, colon or semicolon says the same twice.
    const sep = sepL || sepR;
    out = EDGE_SEPS.has(left[left.length - 1]) || EDGE_SEPS.has(right[0]) ? `${left} ${right}` : `${left} ${sep} ${right}`;
  } else out = joint ? `${left}${joint}${right}` : `${left} ${right}`;
  return cutLeftAFault(text, out) ? null : out;
}

const untidy = (hit) => ambiguity('untidy_cut', `taking ${quote(hit.text)} out would leave the name untidy; nothing read`);

/**
 * Read the label sweetness word out of a wine NAME, on a table the caller
 * loaded (sync). Returns { name, term, ambiguous }:
 *
 *   term       a copy of the row the name states as a word of its own, or null;
 *   name       the name without that word (cutSpan says what goes with it),
 *              or the name unchanged when nothing was read, or when no letter
 *              would be left ("Brut", "Brut 2012": the word is what calls the
 *              wine);
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
 *                              "halb trocken", "Brut Sans Dosage");
 *                glued_word    joined to a neighbour by / . or ' ("Demi/Sec");
 *                place_word    the word also stands in the wine's appellation,
 *                              region or producer ("Arroyo Seco");
 *                untidy_cut    the cut cannot tidy what it would leave ("Brut
 *                              & Rosé"): nothing is removed;
 *                inside_word   a term inside a longer word ("Prosecco");
 *                no_scale      the wine has no type, so the scale is unknown;
 *                too_long      a name over 300 characters is not read.
 *
 * `scale` is the wine's (sweetnessOps.scaleForType): false (fortified, not a
 * wine) reads nothing. `keep` is the wine's sweetnessInName: the word IS the
 * name, so nothing is removed and nothing is read from it. `places` are the
 * wine's appellation, region and producer as text (a string, or a list of
 * strings or { name } objects). Matching is by whole words, names and
 * synonyms, casing, ß and accents folded the way the table folds them
 * (normalizeSweetnessTerm), through the alias spellings. The switch is not
 * read here.
 */
function extractLoaded(terms, name, { scale = null, keep = false, countryId = null, places = [] } = {}) {
  const text = typeof name === 'string' ? name : '';
  const none = { name: text, term: null, ambiguous: null };
  if (scale === false || keep || !text.trim() || !terms || terms.empty) return none;
  if (text.length > NAME_MAX) return { ...none, ambiguous: ambiguity('too_long', `the name is over ${NAME_MAX} characters; not read`) };
  const index = scaleIndex(terms, scale);
  const words = sweetnessWords(text);
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
  const doubt = neighbourhoodDoubt(text, words, hit, placeKeysOf(places));
  if (doubt) return { ...none, ambiguous: doubt };
  if (scale === 'still' && hit.lastWord !== words.length - 1) {
    return { ...none, ambiguous: ambiguity('not_at_end', `${quote(hit.text)} is not the last word of the name; not read as the label sweetness`) };
  }
  const cut = cutSpan(text, hit.start, hit.end);
  if (cut === null) return { ...none, ambiguous: untidy(hit) };
  const out = cut.trim();
  return { name: /\p{L}/u.test(out) ? out : text, term: copyRow(hit.row), ambiguous: null };
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

/**
 * Every term the name states as words of its own, the English words included,
 * each with `doubt`: why the reader itself would not read it (a modifier, a
 * glued word, a place word, a cut it cannot tidy), or null.
 */
function nameHits(terms, name, { scale, keep, countryId, places = [] }) {
  if (keep || !scale || terms.empty) return [];
  const text = typeof name === 'string' ? name : '';
  if (text.length > NAME_MAX) return [];
  const words = sweetnessWords(text);
  const placeKeys = placeKeysOf(places);
  return standaloneHits(text, words, scaleIndex(terms, scale)).map((h) => ({
    ...h,
    row: resolveLoaded(terms, h.key, { scale, countryId }),
    doubt: neighbourhoodDoubt(text, words, h, placeKeys) || (cutSpan(text, h.start, h.end) === null ? untidy(h) : null),
  }));
}

/** The terms the name states as words of its own (the English words aside), each with its doubt. */
function nameTerms(terms, name, opts) {
  return nameHits(terms, name, opts).filter((h) => !NAME_AMBIGUOUS_WORDS.has(h.key));
}

/**
 * The name's word held against a term: { clash } for the first word that
 * states another term and that the reader stands by, else { doubted } for one
 * it doubts (reported, never a contradiction), else {}.
 */
function nameAgainst(terms, name, row, opts) {
  const other = nameTerms(terms, name, opts).filter((h) => h.row && !sameTerm(h.row, row));
  const clash = other.find((h) => !h.doubt);
  if (clash) return { clash };
  return other.length ? { doubted: other[0].doubt } : {};
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

/**
 * The wine's appellation, region and producer, as text a name word is checked
 * against. A region loaded as an id only is read by its name (one lookup,
 * only with a database connection).
 */
async function placesOf(target) {
  const region = target.region;
  let regionName = region && typeof region === 'object' && typeof region.name === 'string' ? region.name : null;
  if (!regionName && region != null && mongoose.connection.readyState === 1 && ID_RX.test(String(idOf(region)))) {
    const row = await Region.findById(String(idOf(region))).select('name').lean();
    regionName = row && typeof row.name === 'string' ? row.name : null;
  }
  return [target.appellation, regionName, target.producer].filter((p) => typeof p === 'string' && p.trim());
}

// A stored term the table cannot name (a populated row it does not hold):
// never equal to any row's id.
const UNNAMED_TERM = '[a term this table does not hold]';

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
 * lenient (a member, a scan, an import, a peer) drops and marks. The stored
 * term is recognised however the target was loaded: an id, or a populated
 * row with or without its id (storedRow).
 *
 *   explicit term  resolved on the wine's scale (and country). Unknown word:
 *                  strict → refused with the known terms, lenient → dropped,
 *                  marker unknown_term (type_mismatch when the word is a term
 *                  of the other scale). Fortified / not wine: strict →
 *                  refused, lenient → dropped. A different term in the name,
 *                  or a dry-side term on a Prädikat sweet by law: strict →
 *                  refused (term_contradiction), lenient → nothing written,
 *                  marker term_contradiction. A word in the name the reader
 *                  itself doubts (beside a modifier, glued, a place word, a
 *                  cut it cannot tidy) is no contradiction: the term is
 *                  written and the doubt reported in `ambiguous`. Else
 *                  written; with the switch on, the same word leaves the name.
 *   a new type     the stored term moves to the same word on the new scale
 *                  (trocken → the Sekt "Trocken"), held against the name like
 *                  an explicit term (strict → refused, lenient → not moved,
 *                  marker term_contradiction); when that scale has no such
 *                  word, or the wine is now fortified: strict → refused
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
  const places = await placesOf(target);
  const readOpts = { keep, countryId: cid, places };
  /** The id of the term the target holds now (UNNAMED_TERM when the table cannot name it), or null. */
  const storedId = () => {
    const held = storedRow(terms, target.labelSweetness);
    if (held == null) return null;
    if (held === 'unresolved') return String(idOf(target.labelSweetness));
    return held._id != null ? String(held._id) : UNNAMED_TERM;
  };

  // A contradiction: refused on the strict path, marked on the lenient one.
  const contradiction = (word, detail) => {
    if (strict) return refuse('term_contradiction', word, `The term was not written: ${detail}.`);
    if (word) result.dropped.push(echo(word));
    return mark(target, result, 'term_contradiction', detail);
  };
  const moveWordOutOfName = (row) => {
    if (!extract) return;
    const read = extractLoaded(terms, currentName, { scale, ...readOpts });
    result.ambiguous = read.ambiguous;
    if (read.term && sameId(read.term._id, row._id) && read.name !== currentName) {
      target.name = read.name; result.name = read.name; result.changed = true;
    }
  };
  const writeTerm = (row) => {
    if (!sameId(storedId(), row._id)) { target.labelSweetness = row._id; result.changed = true; }
    result.term = copyRow(row);
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
    const inName = nameAgainst(terms, currentName, row, { scale: scale || row.scale, ...readOpts });
    if (inName.clash) return contradiction(word, `the name states ${quote(inName.clash.text)}, the term given is ${quote(row.name)}`);
    const byLaw = pradikatContradiction(row, wineLike);
    if (byLaw) return contradiction(word, byLaw);
    writeTerm(row);
    moveWordOutOfName(row);
    if (!result.ambiguous && inName.doubted) result.ambiguous = inName.doubted;
    return result;
  }

  // A new type: the stored term follows it to the same word on the new scale,
  // held against the name like an explicit term. Decided here, written last,
  // so a refusal below leaves the wine untouched.
  let moved = null;
  if (typeSet && target.labelSweetness != null && !terms.empty) {
    const heldRow = storedRow(terms, target.labelSweetness);
    const storedTerm = heldRow && heldRow !== 'unresolved' && heldRow.scale ? heldRow : null;
    if (storedTerm && scale !== null && storedTerm.scale !== scale) {
      moved = scale === false ? null : resolveLoaded(terms, storedTerm.name, { scale, countryId: cid });
      if (!moved) {
        const detail = scale === false
          ? `the wine is now ${nonWine ? 'not a wine' : 'fortified'}, and keeps the term ${quote(storedTerm.name)}`
          : `the term ${quote(storedTerm.name)} is for ${scaleWords(storedTerm.scale)}; the wine is now ${scaleWords(scale)}`;
        if (strict) return refuse('type_mismatch', storedTerm.name, `The type was not changed: ${detail}. Clear or change the term first.`);
        return mark(target, result, 'type_mismatch', detail);
      }
      const inName = nameAgainst(terms, currentName, moved, { scale, ...readOpts });
      const why = inName.clash
        ? `the name states ${quote(inName.clash.text)}, the term moved to the new type is ${quote(moved.name)}`
        : pradikatContradiction(moved, wineLike);
      if (why) {
        if (strict) return refuse('term_contradiction', '', `The type was not changed: ${why}.`);
        return mark(target, result, 'term_contradiction', why);
      }
      if (inName.doubted) result.ambiguous = inName.doubted;
    }
  }
  const storedNow = moved ? String(moved._id) : storedId();
  const finish = () => { if (moved) writeTerm(moved); return result; };

  // No term given: only the switch reads one off a name, and only off a name
  // (or a scale) this write sets — a write that touches neither leaves the
  // name to the migration and the curators.
  if (!extract || scale === false || (!nameSet && !typeSet)) return finish();
  const read = extractLoaded(terms, currentName, { scale, ...readOpts });
  if (read.ambiguous) {
    result.ambiguous = read.ambiguous;
    // Settled: every term the name states is the one the record holds.
    const named = nameHits(terms, currentName, { scale, ...readOpts });
    const settled = storedNow != null && named.length > 0 && named.every((h) => h.row && sameId(h.row._id, storedNow));
    if (settled || !MARKED_AMBIGUITIES.has(read.ambiguous.kind)) return finish();
    finish();
    return mark(target, result, 'name_ambiguous', read.ambiguous.detail);
  }
  if (!read.term) return finish();
  if (storedNow != null && !sameId(storedNow, read.term._id)) {
    const heldRow = storedRow(terms, target.labelSweetness);
    const storedName = heldRow && heldRow !== 'unresolved' ? heldRow.name : 'another term';
    return contradiction('', `the name states ${quote(read.term.name)}, the record states ${quote(storedName)}`);
  }
  const byLaw = pradikatContradiction(read.term, wineLike);
  if (byLaw) return contradiction('', byLaw);
  writeTerm(read.term);
  if (read.name !== currentName) { target.name = read.name; result.name = read.name; result.changed = true; }
  return result;
}

// ── The sweetness style ──────────────────────────────────────────────────────

// Who may name a style, weakest first: a value replaces a stored one only
// from a stronger source (producer beats trade). The keys are the model's
// sources (WineDefinition.SWEETNESS_STYLE_SOURCES).
const STYLE_SOURCE_RANK = Object.freeze({ trade: 1, producer: 2 });

/**
 * THE write rule for a wine's sweetness style (WineDefinition.sweetnessStyle):
 * the term the wine is KNOWN by when its label prints none, named by the
 * producer or the trade, with the page that names it. Sets `sweetnessStyle`,
 * or the `sweetnessReview` marker, on `target`. Callers: the Registry Bridge
 * copy (services/registryBridge); no REST or MCP caller yet.
 *
 * Input: `term` as printed (or a term row id) — null or '' clears the style
 * (the caller decides who may clear), undefined leaves it; `source`
 * 'producer' | 'trade'; `url` the http(s) page that names the term; `type` /
 * `countryId` default to the target's own. `strict` refuses what lenient
 * drops: a style is never stored without its source, so invalid input is
 * neither kept nor marked.
 *
 * Returns { ok: true, changed, verdict, reason, style, review, message? } —
 * `style` the value on the target after the call, `review` the marker set —
 * with `verdict`:
 *   applied       written: a blank filled, or a stronger source replaced a
 *                 weaker one
 *   unchanged     the same term from an equal or weaker source (the stored
 *                 value and link stay), or no term given
 *   needs_review  a different term from an equal or weaker source: NOT
 *                 written (reason equal_source | weaker_source); the caller
 *                 sends it to a person
 *   redundant     the label's own term is the same term: the style is cleared
 *   held          contradicts the label's term, or a Prädikat sweet by law:
 *                 nothing written, marker term_contradiction
 *   cleared       null or '' given: the style removed
 *   dropped       lenient only — invalid input (reason as below, or no_table)
 * or, strict, { ok: false, code: 'invalid_input', reason, message }, reason ∈
 * no_scale | unknown_term | type_mismatch | bad_source | url_required |
 * bad_url | regulated_needs_producer. Reason codes for the caller, not an
 * HTTP body.
 */
async function assignSweetnessStyle(target, { term, source, url, type, countryId = null, strict = false } = {}) {
  const terms = await loadTerms();
  const done = (verdict, extra = {}) => ({
    ok: true, changed: false, verdict, reason: null, review: null, ...extra, style: target.sweetnessStyle ?? null,
  });
  const invalid = (reason, message) => (strict
    ? { ok: false, code: 'invalid_input', reason, message }
    : done('dropped', { reason, message }));
  const held = (detail) => mark(target, done('held', { reason: 'term_contradiction' }), 'term_contradiction', detail);

  if (term === undefined) return done('unchanged');
  const word = term == null ? '' : String(term).trim();
  if (!word) {
    const had = target.sweetnessStyle != null;
    if (had) target.sweetnessStyle = null;
    return done('cleared', { changed: had });
  }
  const nonWine = target.nonWine === true;
  const scale = scaleForType(type !== undefined ? type : target.type, { nonWine });
  if (scale === false) {
    return invalid('no_scale', nonWine ? 'A drink that is not wine has no sweetness style.' : 'Fortified wines have no sweetness style yet.');
  }
  const src = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (!STYLE_SOURCE_RANK[src]) {
    return invalid('bad_source', `The source of a sweetness style is "producer" or "trade", not "${String(source ?? '').slice(0, 40)}".`);
  }
  const link = typeof url === 'string' ? url.trim() : '';
  if (!link) return invalid('url_required', 'A sweetness style needs the link to the page that names it.');
  if (link.length > URL_MAX || !isSafeUrl(link)) {
    return invalid('bad_url', `The link must be an http:// or https:// URL of at most ${URL_MAX} characters.`);
  }
  // No table (no database connection, nothing seeded): nothing resolves.
  if (terms.empty) return done('dropped', { reason: 'no_table' });

  const cid = countryId || idOf(target.country) || null;
  const found = termFor(terms, word, { scale, countryId: cid });
  if (!found.row) {
    if (found.bothScales) return invalid('type_mismatch', `"${word}" is a term of both scales; the wine's type decides which. Set the type first.`);
    if (found.otherScale) return invalid('type_mismatch', `"${word}" is a term for ${scaleWords(found.otherScale)}, and this is ${scaleWords(scale)}.`);
    return invalid('unknown_term', `"${word}" is not a sweetness term for ${scaleWords(scale)}. Known terms here: ${knownTermsHint(terms, scale, cid)}. A term the list lacks is added under Admin → Taxonomy → Sweetness terms.`);
  }
  const row = found.row;
  // A legal definition is a statement by the wine; a merchant's "trocken" is not.
  if (row.regulated !== false && src !== 'producer') {
    return invalid('regulated_needs_producer', `"${row.name}" is a term with a legal definition; only the producer names it as a style (source "producer").`);
  }

  // The label's own term wins: the same term makes the style redundant, a
  // different one is a question for a person.
  const label = storedRow(terms, target.labelSweetness);
  if (label === 'unresolved') return held(`the label states a term this server cannot name; the style "${row.name}" was not written`);
  if (label) {
    if (!sameTerm(label, row)) return held(`the label states "${label.name}", the style named is "${row.name}"`);
    const had = target.sweetnessStyle != null;
    if (had) target.sweetnessStyle = null;
    return done('redundant', { changed: had });
  }
  const byLaw = pradikatContradiction(row, { name: target.name, classifications: target.classifications, classification: target.classification });
  if (byLaw) return held(byLaw);

  // A stored style yields only to a stronger source, so two contributors who
  // disagree cannot flip a wine back and forth.
  const current = target.sweetnessStyle;
  if (current && current.term != null) {
    const stronger = STYLE_SOURCE_RANK[src] > (STYLE_SOURCE_RANK[current.source] || 0);
    const currentRow = storedRow(terms, current.term);
    if (currentRow !== 'unresolved' && sameTerm(currentRow, row)) {
      if (!stronger) return done('unchanged');
    } else if (!stronger) {
      return done('needs_review', { reason: STYLE_SOURCE_RANK[src] === STYLE_SOURCE_RANK[current.source] ? 'equal_source' : 'weaker_source' });
    }
  }
  target.sweetnessStyle = { term: row._id, source: src, url: link };
  return done('applied', { changed: true });
}

module.exports = {
  extractFromName, extractLoaded, assignSweetness, assignSweetnessStyle, STYLE_SOURCE_RANK,
  // Tests: the cut on names longer than the reader accepts, for its time bound.
  __testing: { cutSpan },
};
