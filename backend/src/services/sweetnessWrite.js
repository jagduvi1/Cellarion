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
 * No write path calls the rule yet; the mint, the admin forms, the proposals,
 * the draft publish, the import, the scan and the Bridge are wired to it
 * separately.
 */
const constants = require('../config/constants');
const { normalizeSweetnessTerm } = require('../utils/normalize');
const { NAME_AMBIGUOUS_WORDS, statedStyle, sweetByLawPradikat } = require('../utils/styleTerms');
const { loadTerms, resolveLoaded, scaleForType } = require('./sweetnessOps');

// A word of a name: letters (with their marks) and digits. Everything else —
// spaces, commas, hyphens, apostrophes, brackets — stands between words.
const WORD_RX = /[\p{L}\p{M}\p{N}]+/gu;
// What may stand between the words of ONE term in a name ("Brut Nature",
// "Extra-Brut"). A comma or a slash ends a term.
const TERM_GAP_RX = /^[\s\-‐‑]+$/u;
// The separators a cut may leave dangling ("Riesling, trocken" → "Riesling,").
const LEADING_SEP_RX = /^[\s,;:/|·\-–—]+/u;
const TRAILING_SEP_RX = /[\s,;:/|·\-–—]+$/u;
const ENDS_WITH_SEP_RX = /[,;:/|·\-–—]$/u;
const STARTS_WITH_SEP_RX = /^[,;:/|·\-–—]/u;
// Punctuation that sits against the word before it ("Riesling, Alte Reben").
const STARTS_WITH_ATTACHED_RX = /^[,;:]/u;
const OPEN_BRACKET_RX = /[([]$/u;
const CLOSE_BRACKET_RX = /^[)\]]/u;
const ID_RX = /^[0-9a-f]{24}$/i;

// The sweetnessReview.detail limit (models/WineDefinition).
const DETAIL_MAX = 300;
const clip = (s) => String(s).slice(0, DETAIL_MAX);

// The bands no Prädikat that is sweet by law can carry: the dry and off-dry
// bands of the still scale, and the sparkling bands up to extra dry. The band
// reading of DRY_SIDE_WORDS in utils/styleTerms, which makes the same
// judgement on the words of a NAME; read by band here so a term in any
// language counts ("secco", "száraz", "Pas Dosé").
const DRY_SIDE_BANDS = new Set(['dry', 'off-dry', 'brut-nature', 'extra-brut', 'brut', 'extra-dry']);

// The ambiguities that mark a wine for a curator when the switch reads a name
// being written. A term inside a longer word is reported to the caller but
// not marked: every Prosecco and every Dolcetto carries one, and neither
// states a sweetness.
const MARKED_AMBIGUITIES = new Set(['english_word', 'two_terms', 'not_at_end', 'no_scale']);

const idOf = (v) => (v && typeof v === 'object' && v._id ? v._id : v);
const sameId = (a, b) => a != null && b != null && String(idOf(a)) === String(idOf(b));
const scaleWords = (scale) => (scale === 'sparkling' ? 'a sparkling wine' : 'a still wine');

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

function wordsOf(text) {
  return [...text.matchAll(WORD_RX)].map((m) => ({
    text: m[0], start: m.index, end: m.index + m[0].length, key: normalizeSweetnessTerm(m[0]),
  }));
}

/**
 * The spellings of the scale's terms that stand in the name as words of their
 * own, longest first, never overlapping. A span of several words counts only
 * when spaces or hyphens join them, and matches its spelling either way it is
 * folded ("Extra-Brut" → "extrabrut", or word by word → "extra brut").
 */
function standaloneHits(text, words, index) {
  const taken = new Array(words.length).fill(false);
  const hits = [];
  for (let len = Math.min(index.maxWords, words.length); len >= 1; len -= 1) {
    for (let i = 0; i + len <= words.length; i += 1) {
      const span = words.slice(i, i + len);
      if (span.some((_, n) => taken[i + n])) continue;
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
    if (hit) return ambiguity('inside_word', `"${hit.name}" sits inside the word "${w.text}"; not read as the label sweetness`);
  }
  return null;
}

const ambiguity = (kind, detail) => ({ reason: 'name_ambiguous', kind, detail: clip(detail) });

/**
 * Cut [start, end) out of a name and tidy what the cut leaves: the space, a
 * dangling separator, an emptied bracket. The rest of the name keeps its
 * characters exactly.
 */
function cutSpan(text, start, end) {
  let left = text.slice(0, start).replace(/\s+$/u, '');
  let right = text.slice(end).replace(/^\s+/u, '');
  if (OPEN_BRACKET_RX.test(left) && CLOSE_BRACKET_RX.test(right)) {
    left = left.slice(0, -1).replace(/\s+$/u, '');
    right = right.slice(1).replace(/^\s+/u, '');
  }
  if (OPEN_BRACKET_RX.test(left)) return left + right.replace(LEADING_SEP_RX, '');
  if (CLOSE_BRACKET_RX.test(right)) return left.replace(TRAILING_SEP_RX, '') + right;
  if (!right) return left.replace(TRAILING_SEP_RX, '');
  if (!left) return right.replace(LEADING_SEP_RX, '');
  if (ENDS_WITH_SEP_RX.test(left) && STARTS_WITH_SEP_RX.test(right)) return `${left} ${right.replace(LEADING_SEP_RX, '')}`;
  if (STARTS_WITH_ATTACHED_RX.test(right)) return `${left}${right}`;
  return `${left} ${right}`;
}

/**
 * Read the label sweetness word out of a wine NAME, on a table the caller
 * loaded (sync). Returns { name, term, ambiguous }:
 *
 *   term       the row the name states as a word of its own, or null;
 *   name       the name without that word (separators tidied), or the name
 *              unchanged when nothing was read, or when only the word would
 *              be left ("Brut": the word is all there is to call the wine);
 *   ambiguous  null, or { reason: 'name_ambiguous', kind, detail } when the
 *              name holds a term that is NOT read — kind:
 *                english_word  only the English "dry" / "sweet" (Dry Creek,
 *                              Sweet Cheeks: utils/styleTerms
 *                              NAME_AMBIGUOUS_WORDS);
 *                two_terms     two different terms; nothing is removed;
 *                not_at_end    a still-wine term that is not the last word
 *                              ("Dolce Vita"); a sparkling term is read
 *                              anywhere, the dosage words leave every
 *                              sparkling name;
 *                inside_word   a term inside a longer word ("Prosecco");
 *                no_scale      the wine has no type, so the scale is unknown.
 *
 * `scale` is the wine's (sweetnessOps.scaleForType): false (fortified, not a
 * wine) reads nothing. `keep` is the wine's sweetnessInName: the word IS the
 * name, so nothing is removed and nothing is read from it. Matching is by
 * whole words, names and synonyms, casing, ß and accents folded the way the
 * table folds them (normalizeSweetnessTerm).
 */
function extractLoaded(terms, name, { scale = null, keep = false, countryId = null } = {}) {
  const text = typeof name === 'string' ? name : '';
  const none = { name: text, term: null, ambiguous: null };
  if (scale === false || keep || !text.trim() || !terms || terms.empty) return none;
  const index = scaleIndex(terms, scale);
  const words = wordsOf(text);
  const all = standaloneHits(text, words, index);
  if (!all.length) return { ...none, ambiguous: insideWord(words, index) };
  // The English words are ordinary name words beside a real term, and only a
  // clue when they stand alone (the style guard reads names the same way).
  const hits = all.filter((h) => !NAME_AMBIGUOUS_WORDS.has(h.key));
  if (!hits.length) {
    return { ...none, ambiguous: ambiguity('english_word', `"${all[0].text}" may be an ordinary English word of the name; not read as the label sweetness`) };
  }
  if (scale === null) {
    return { ...none, ambiguous: ambiguity('no_scale', `the wine has no type, so the scale of "${hits[0].text}" is unknown`) };
  }
  for (const h of hits) h.row = resolveLoaded(terms, h.key, { scale, countryId });
  const distinct = [...new Map(hits.map((h) => [String(h.row._id), h.row])).values()];
  if (distinct.length > 1) {
    return { ...none, ambiguous: ambiguity('two_terms', `the name states more than one sweetness term (${hits.map((h) => `"${h.text}"`).join(', ')}); nothing read`) };
  }
  if (scale === 'still' && (hits.length > 1 || hits[0].lastWord !== words.length - 1)) {
    return { ...none, ambiguous: ambiguity('not_at_end', `"${hits[0].text}" is not the last word of the name; not read as the label sweetness`) };
  }
  let out = text;
  for (const h of [...hits].reverse()) out = cutSpan(out, h.start, h.end);
  out = out.trim();
  const term = distinct[0];
  return { name: /[\p{L}\p{N}]/u.test(out) ? out : text, term, ambiguous: null };
}

/**
 * The same, loading the term table first (an empty table reads nothing). No
 * REST or MCP caller yet; the migration and the write paths will call it.
 * Returns { name, term, ambiguous } as extractLoaded.
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
  if (ID_RX.test(word) && terms.byId.has(word)) {
    const row = terms.byId.get(word);
    return !scale || row.scale === scale ? { row } : { otherScale: row.scale };
  }
  const row = resolveLoaded(terms, word, { scale, countryId });
  if (row) return { row };
  const rows = terms.byKey.get(normalizeSweetnessTerm(word)) || [];
  if (!rows.length) return {};
  const scales = [...new Set(rows.map((r) => r.scale))];
  return scale ? { otherScale: scales.find((s) => s !== scale) || scales[0] } : { bothScales: true };
}

/** The terms the name states as words of their own (the English words aside). */
function nameTerms(terms, name, { scale, keep, countryId }) {
  if (keep || !scale || terms.empty) return [];
  const text = typeof name === 'string' ? name : '';
  return standaloneHits(text, wordsOf(text), scaleIndex(terms, scale))
    .filter((h) => !NAME_AMBIGUOUS_WORDS.has(h.key))
    .map((h) => ({ ...h, row: resolveLoaded(terms, h.key, { scale, countryId }) }));
}

/** Why this term cannot sit on a wine whose Prädikat is sweet by law, or null. */
function pradikatContradiction(row, wineLike) {
  if (!DRY_SIDE_BANDS.has(row.band)) return null;
  const tier = sweetByLawPradikat(wineLike);
  return tier ? `${tier} is sweet by law, but the term "${row.name}" is ${row.band}` : null;
}

/** Set the review marker; the same reason keeps the first `since`. */
function mark(target, result, reason, detail) {
  const prev = target.sweetnessReview;
  const since = prev && prev.reason === reason && prev.since ? prev.since : new Date();
  target.sweetnessReview = { reason, detail: clip(detail), since };
  result.review = target.sweetnessReview;
  return result;
}

const refuse = (reason, word, message) => ({ ok: false, code: 'invalid_input', reason, unresolved: [word], message });

/**
 * THE write rule for a wine's label sweetness. Sets `labelSweetness` (a term
 * row id), and — when the word leaves it — `name`, on `target` (a
 * WineDefinition document or the plain fields of one being built); sets
 * `sweetnessReview` when a curator must look. No REST or MCP caller yet.
 *
 * Input: `labelSweetness` — the term as printed (or a term row id); undefined
 * leaves the field alone, null or '' clears it. `name`, `type`, `countryId`
 * default to the target's own; pass them when the same write sets them.
 * `strict` (a curator at a form or tool) refuses what lenient (a member, a
 * scan, an import, a peer) drops.
 *
 *   explicit term  resolved on the wine's scale (and country). Unknown word:
 *                  strict → refused with the known terms, lenient → dropped,
 *                  marker unknown_term (type_mismatch when the word is a term
 *                  of the other scale). Fortified / not wine: strict →
 *                  refused, lenient → dropped. A different term in the name,
 *                  or a dry-side term on a Prädikat sweet by law: nothing
 *                  written, marker term_contradiction. Else written; with the
 *                  switch on, the same word leaves the name.
 *   no term given  switch off: nothing. Switch on, and the write sets the
 *                  name or the type: the name's word moves into the field
 *                  (extractLoaded), unless the wine is marked sweetnessInName;
 *                  an ambiguous name is marked name_ambiguous (a term inside
 *                  a word is only reported); a name word that differs from
 *                  the stored term, or contradicts the Prädikat, is marked
 *                  term_contradiction and nothing moves.
 *
 * Returns { ok: true, changed, term, name, dropped, review, ambiguous } —
 * `changed` when labelSweetness or name was written, `term` the row written
 * (null when none), `name` the new name when the word left it (else null),
 * `dropped` the words not written, `review` the marker set (else null),
 * `ambiguous` what the name reading could not decide — or
 * { ok: false, code: 'invalid_input', reason, unresolved, message } on a
 * strict refusal (reason: unknown_term | type_mismatch | no_scale), when
 * nothing is written. A reason code for the caller, not an HTTP body: the
 * caller answers in its own words (REST error body, MCP failure).
 */
async function assignSweetness(target, { labelSweetness, name, type, countryId = null, strict = false } = {}) {
  const terms = await loadTerms();
  const result = { ok: true, changed: false, term: null, name: null, dropped: [], review: null, ambiguous: null };
  const extract = constants.SWEETNESS_EXTRACT_FROM_NAME === true;
  const nonWine = target.nonWine === true;
  const scale = scaleForType(type !== undefined ? type : target.type, { nonWine });
  const currentName = typeof name === 'string' ? name : (typeof target.name === 'string' ? target.name : '');
  const keep = target.sweetnessInName === true;
  const cid = countryId || idOf(target.country) || null;
  const wineLike = { name: currentName, classifications: target.classifications, classification: target.classification };

  const moveWordOutOfName = (row) => {
    if (!extract) return;
    const read = extractLoaded(terms, currentName, { scale, keep, countryId: cid });
    result.ambiguous = read.ambiguous;
    if (read.term && sameId(read.term._id, row._id) && read.name !== currentName) {
      target.name = read.name; result.name = read.name; result.changed = true;
    }
  };
  const writeTerm = (row) => {
    if (!sameId(target.labelSweetness, row._id)) { target.labelSweetness = row._id; result.changed = true; }
    result.term = row;
  };

  if (labelSweetness !== undefined) {
    const word = labelSweetness == null ? '' : String(labelSweetness).trim();
    if (!word) {
      if (target.labelSweetness != null) { target.labelSweetness = null; result.changed = true; }
      return result;
    }
    if (scale === false) {
      if (strict) {
        return refuse('no_scale', word, nonWine
          ? `A drink that is not wine has no label sweetness; "${word}" was not set.`
          : `Fortified wines have no label sweetness yet; "${word}" was not set.`);
      }
      result.dropped.push(word);
      return result;
    }
    // No table (no database connection, nothing seeded): nothing resolves.
    if (terms.empty) { result.dropped.push(word); return result; }

    const found = termFor(terms, word, { scale, countryId: cid });
    if (!found.row) {
      const reason = found.otherScale || found.bothScales ? 'type_mismatch' : 'unknown_term';
      if (strict) {
        let message;
        if (found.bothScales) message = `"${word}" is a term of both scales; the wine's type decides which. Set the type first.`;
        else if (found.otherScale) message = `"${word}" is a term for ${scaleWords(found.otherScale)}, and this is ${scaleWords(scale)}. Known terms here: ${knownTermsHint(terms, scale, cid)}.`;
        else message = `"${word}" is not a label sweetness term for ${scaleWords(scale)}. Known terms here: ${knownTermsHint(terms, scale, cid)}. A term the list lacks is added under Admin → Taxonomy → Sweetness terms.`;
        return refuse(reason, word, message);
      }
      result.dropped.push(word);
      let detail;
      if (found.bothScales) detail = `"${word}" was given, and the wine has no type to say which scale it is on`;
      else if (found.otherScale) detail = `"${word}" was given, a term for ${scaleWords(found.otherScale)}; the wine is ${scaleWords(scale)}`;
      else detail = `"${word}" was given, a word the sweetness term table does not have`;
      return mark(target, result, reason, detail);
    }
    const row = found.row;
    const inName = nameTerms(terms, currentName, { scale, keep, countryId: cid }).find((h) => h.row && !sameId(h.row._id, row._id));
    if (inName) {
      return mark(target, result, 'term_contradiction', `the name states "${inName.text}", the term given is "${row.name}"`);
    }
    const byLaw = pradikatContradiction(row, wineLike);
    if (byLaw) return mark(target, result, 'term_contradiction', byLaw);
    writeTerm(row);
    moveWordOutOfName(row);
    return result;
  }

  // No term given: only the switch reads one off a name, and only off a name
  // (or a scale) this write sets — a write that touches neither leaves the
  // name to the migration and the curators.
  if (!extract || scale === false || (name === undefined && type === undefined)) return result;
  const read = extractLoaded(terms, currentName, { scale, keep, countryId: cid });
  if (read.ambiguous) {
    result.ambiguous = read.ambiguous;
    return MARKED_AMBIGUITIES.has(read.ambiguous.kind) ? mark(target, result, 'name_ambiguous', read.ambiguous.detail) : result;
  }
  if (!read.term) return result;
  const stored = target.labelSweetness;
  if (stored != null && !sameId(stored, read.term._id)) {
    const storedName = (terms.byId.get(String(idOf(stored))) || {}).name || 'another term';
    return mark(target, result, 'term_contradiction', `the name states "${read.term.name}", the record states "${storedName}"`);
  }
  const byLaw = pradikatContradiction(read.term, wineLike);
  if (byLaw) return mark(target, result, 'term_contradiction', byLaw);
  writeTerm(read.term);
  if (read.name !== currentName) { target.name = read.name; result.name = read.name; result.changed = true; }
  return result;
}

module.exports = {
  extractFromName, extractLoaded, assignSweetness,
};
