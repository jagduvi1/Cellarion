/**
 * Cellar search, on MongoDB.
 *
 * Until 2026-09 a Meilisearch `bottles` index answered every cellar search. It
 * held a second copy of every bottle — private notes included — for queries
 * that are always about one user's own cellars, had to be written on every
 * bottle change (and drifted: 567 phantom documents on prod 2026-08-13), and
 * was three quarters of Meilisearch's documents. A cellar is small (at most a
 * few thousand bottles), so this module loads the cellars in scope from
 * MongoDB and matches in memory, the way the index did:
 *
 *  - case and accents are ignored, and words split on anything that is not a
 *    letter or a digit ("Châteauneuf-du-Pape" is chateauneuf / du / pape);
 *  - the last word matches as a prefix while it is still being typed ("barol"
 *    finds Barolo);
 *  - typos: one from 5 letters, two from 9, a wrong first letter counting as
 *    two — "chardonay", "barollo" and "chateu margo" find their wines;
 *  - words typed apart match one written together ("chateau neuf") and one
 *    typed word matches two written apart ("pinotnoir");
 *  - several words: bottles matching all of them first, then bottles matching
 *    only the leading ones, dropping words from the end — the index's "last"
 *    matching strategy (the first word must always match);
 *  - ranking: more words matched, fewer typos, the words closer together, a
 *    more important field (FIELDS order), the requested sort, then earlier in
 *    the field and exact words over prefixes and typos.
 *
 * Facet counts come from the same pass (searchBottles) or, for a plain cellar
 * page with no search, from one grouping query (bottleFacets). Unlike the
 * index, every facet value is returned — Meilisearch stopped at 100 per facet.
 *
 * Meilisearch still serves the shared wine registry and the forum
 * (services/search).
 */
const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { CONSUMED_STATUSES } = require('../config/constants');
const { grapeSearchNames } = require('../utils/grapeDisplay');

// Searchable fields, most important first — the order is the field ranking.
const FIELDS = ['wineName', 'producer', 'appellation', 'countryName', 'regionName', 'grapeNames', 'type', 'notes', 'location', 'vintage'];
const FACETS = ['type', 'countryName', 'regionName', 'appellation', 'vintage', 'countryId', 'regionId', 'grapeIds'];
const VALID_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const SORT_FIELDS = { name: 'wineName', createdAt: 'createdAt', vintage: 'vintage', price: 'price', rating: 'rating' };

const MAX_QUERY_WORDS = 10;      // Meilisearch read at most ten query words too
const NEAR = 3;                  // words further apart than this count as not near
const FAR = NEAR + 1;            // proximity cost of words not near, or in different fields
const MAX_OCCURRENCES = 16;      // per query word per bottle — enough to rank, bounded on long notes

const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v));

// ── Text ────────────────────────────────────────────────────────────────────

// Case- and accent-folded: NFKD splits "é" into "e" plus a combining mark,
// which is dropped. æ and œ are letters of their own to NFKD, so unfold them.
function fold(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe');
}

const WORD = /[\p{L}\p{N}]+/gu;
const ENDS_WITH_SEPARATOR = /[^\p{L}\p{N}]$/u;
// A comma, full stop, "!" or "?" followed by a space, or any ";", ends a
// phrase: the index moved the next word 8 positions on, so words on either
// side are never near each other ("Syrah, Merlot" in the grape list).
const HARD_SEPARATOR = /[,.!?]\s|;/;

function toWords(value) {
  if (value === undefined || value === null || value === '') return [];
  return fold(value).match(WORD) || [];
}

/** Words with the positions the index gave them. */
function tokenize(value) {
  const words = [];
  const positions = [];
  if (value === undefined || value === null || value === '') return { words, positions };
  const text = fold(value);
  let end = null;
  let pos = 0;
  for (const m of text.matchAll(WORD)) {
    if (end !== null) pos += HARD_SEPARATOR.test(text.slice(end, m.index)) ? 8 : 1;
    words.push(m[0]);
    positions.push(pos);
    end = m.index + m[0].length;
  }
  return { words, positions };
}

// Filter and facet values compare the way the index compared them: trimmed
// and lower-cased, accents kept.
const facetKey = (value) => String(value).trim().normalize('NFKD').toLowerCase();

// ── Matching ────────────────────────────────────────────────────────────────

const typoBudget = (length) => (length >= 9 ? 2 : length >= 5 ? 1 : 0);

/**
 * Optimal-string-alignment distance (swapping two neighbours is one edit)
 * between `a` and `b` — or, with `prefix`, between `a` and the closest prefix
 * of `b`, which is how a word still being typed matches. Gives up with
 * `max + 1` as soon as the distance must exceed `max`.
 */
function editDistance(a, b, max, prefix) {
  const n = a.length;
  const m = b.length;
  if (prefix ? m < n - max : Math.abs(n - m) > max) return max + 1;
  let before = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = new Array(m + 1);
    row[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2] + 1);
      row[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    before = prev;
    prev = row;
  }
  return prefix ? Math.min(...prev) : prev[m];
}

const EXACT = { typos: 0, exact: true };
const AS_PREFIX = { typos: 0, exact: false };
const ONE_TYPO = { typos: 1, exact: false };
const TWO_TYPOS = { typos: 2, exact: false };

/** How a query element matches one word of a bottle: null, or { typos, exact }. */
function matchWord(element, word) {
  if (word === element.text) return EXACT;
  if (element.prefix && word.startsWith(element.text)) return AS_PREFIX;
  if (element.budget === 0) return null;
  const chars = Array.from(word);
  const distance = editDistance(element.chars, chars, element.budget, element.prefix);
  // A wrong first letter costs two typos, as it did in Meilisearch.
  const sameFirst = chars[0] === element.chars[0];
  if (distance === 1) return sameFirst ? ONE_TYPO : (element.budget >= 2 ? TWO_TYPOS : null);
  if (distance === 2 && sameFirst && element.budget >= 2) return TWO_TYPOS;
  return null;
}

/**
 * The query as match elements: every word, plus every run of two and three
 * consecutive words joined together, each with its typo budget (a joined run
 * gets one typo fewer per extra word) and whether it may match as a prefix
 * (it ends with the last word, and the query does not end in a separator).
 */
function parseQuery(query) {
  const raw = String(query || '');
  const words = toWords(raw).slice(0, MAX_QUERY_WORDS);
  if (words.length === 0) return null;
  const open = !ENDS_WITH_SEPARATOR.test(fold(raw));
  const elements = [];
  const add = (from, to) => {
    const text = words.slice(from, to + 1).join('');
    const chars = Array.from(text);
    elements.push({
      from,
      to,
      text,
      chars,
      prefix: open && to === words.length - 1,
      budget: Math.max(0, typoBudget(chars.length) - (to - from)),
    });
  };
  for (let i = 0; i < words.length; i++) {
    add(i, i);
    if (i + 1 < words.length) add(i, i + 1);
    if (i + 2 < words.length) add(i, i + 2);
  }
  return { words, elements };
}

/**
 * Every place a query element matches in one bottle: occurrences[e] lists
 * { field, pos, span, typos, exact }. `memo` caches word → matching elements
 * across the whole scope, so each distinct word is compared once per request.
 */
function findOccurrences(doc, parsed, memo) {
  const { elements } = parsed;
  const occurrences = elements.map(() => []);
  const push = (e, occurrence) => {
    if (occurrences[e].length < MAX_OCCURRENCES) occurrences[e].push(occurrence);
  };
  doc.fields.forEach(({ words, positions }, field) => {
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const pos = positions[i];
      let matches = memo.get(word);
      if (matches === undefined) {
        matches = [];
        elements.forEach((element, e) => {
          const m = matchWord(element, word);
          if (m) matches.push([e, m]);
        });
        memo.set(word, matches);
      }
      for (const [e, m] of matches) push(e, { field, pos, span: 1, typos: m.typos, exact: m.exact });
      // Typed as one word, written here as two adjacent ones ("pinotnoir" →
      // "pinot noir"); also a joined run ("pino tnoir" → "pinotnoir").
      // Counts one typo.
      const next = words[i + 1];
      if (next !== undefined && positions[i + 1] === pos + 1) {
        elements.forEach((element, e) => {
          if (element.text.length > word.length
            && element.text.startsWith(word) && element.text.slice(word.length) === next) {
            push(e, { field, pos, span: 2, typos: 1, exact: false });
          }
        });
      }
    }
  });
  return occurrences;
}

/**
 * Proximity of two consecutive query elements: 1 = adjacent in order, up to
 * NEAR words apart, written the other way round one more, FAR otherwise or
 * in different fields.
 */
function pairProximity(as, bs) {
  let best = FAR;
  for (const a of as) {
    for (const b of bs) {
      if (a.field !== b.field) continue;
      const aEnd = a.pos + a.span - 1;
      const d = b.pos > aEnd ? b.pos - aEnd : a.pos - b.pos + 1;
      if (d < best) best = d > NEAR ? FAR : d;
    }
  }
  return best;
}

// A word's distance from where the query puts it, in the index's buckets:
// exact up to 15, then 24, then powers of two, then coarse cost bands.
function positionCost(distance) {
  const p = distance < 16 ? distance : distance < 24 ? 24 : 2 ** Math.ceil(Math.log2(distance));
  if (p <= 1) return p;
  if (p <= 4) return 2;
  if (p <= 7) return 3;
  if (p <= 11) return 4;
  if (p <= 16) return 5;
  if (p <= 24) return 6;
  if (p <= 64) return 7;
  if (p <= 256) return 8;
  if (p <= 1024) return 9;
  return 10;
}

const startsWithWords = (words, prefix) => prefix.every((w, i) => words[i] === w);

/**
 * Rank one bottle against the query, or null when it does not match. Each
 * number mirrors one of the index's ranking rules (lower is better, except
 * `bucket`):
 *  - bucket: how many leading query words match — the "last" matching
 *    strategy drops words from the end, and the first word must match;
 *  - typos: fewest typos over a cover of those words by single words and
 *    joined runs (a run of k words costs k on top of its own typos);
 *  - proximity: consecutive covered words, see pairProximity (a joined run
 *    costs NEAR per extra word inside it);
 *  - attribute: the most important field each covered element occurs in;
 *  - position: how far each element sits from its place in the query;
 *  - exactness: 0 when a whole field is exactly the words that matched
 *    exactly, 1 when a field starts with them, else 2 + the words that did
 *    not match exactly.
 */
function rankDocument(doc, parsed, memo) {
  const occurrences = findOccurrences(doc, parsed, memo);
  const { elements } = parsed;
  const n = parsed.words.length;
  const elementTypos = (e) => {
    const own = Math.min(...occurrences[e].map((o) => o.typos));
    const runLength = elements[e].to - elements[e].from + 1;
    return runLength > 1 ? own + runLength : own;
  };
  // reach[i]: fewest typos covering words 0..i-1, with the element used last.
  const reach = new Array(n + 1).fill(null);
  reach[0] = { typos: 0, element: -1 };
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    elements.forEach((element, e) => {
      if (element.to !== i || !reach[element.from] || occurrences[e].length === 0) return;
      const typos = reach[element.from].typos + elementTypos(e);
      if (!reach[i + 1] || typos < reach[i + 1].typos) reach[i + 1] = { typos, element: e };
    });
    if (reach[i + 1]) bucket = i + 1;
  }
  if (bucket === 0) return null;

  const path = [];
  for (let i = bucket; i > 0;) {
    const e = reach[i].element;
    path.unshift(e);
    i = elements[e].from;
  }
  // Every later rule looks only at the matches the typo rule kept, as the
  // index did: "france" ranks a bottle by its country "France" (no typo), not
  // by "Francs" in its name (one typo).
  const kept = path.map((e) => {
    const fewest = Math.min(...occurrences[e].map((o) => o.typos));
    return occurrences[e].filter((o) => o.typos === fewest);
  });
  let proximity = 0;
  let attribute = 0;
  let position = 0;
  const exactWords = [];
  path.forEach((e, k) => {
    const occ = kept[k];
    const element = elements[e];
    if (k > 0) proximity += pairProximity(kept[k - 1], occ);
    proximity += (element.to - element.from) * NEAR;
    attribute += Math.min(...occ.map((o) => o.field));
    position += Math.min(...occ.map((o) => positionCost(Math.abs(o.pos - element.from))));
    if (element.from === element.to && occ.some((o) => o.exact)) exactWords.push(element.text);
  });
  let exactness = 2 + (bucket - exactWords.length);
  if (exactWords.length > 0) {
    for (const { words } of doc.fields) {
      if (words.length === exactWords.length && startsWithWords(words, exactWords)) { exactness = 0; break; }
      if (exactness > 1 && words.length > exactWords.length && startsWithWords(words, exactWords)) exactness = 1;
    }
  }
  return { bucket, typos: reach[bucket].typos, proximity, attribute, position, exactness };
}

// ── Documents ───────────────────────────────────────────────────────────────

const populatedName = (ref) => (ref && typeof ref === 'object' && ref.name) || '';
const refId = (ref) => (ref ? String(ref._id || ref) : '');

/** The searchable, filterable and sortable view of one bottle. */
function buildSearchDoc(bottle, wine) {
  const w = wine || {};
  const vintage = bottle.vintage === undefined || bottle.vintage === null ? '' : String(bottle.vintage);
  const values = {
    wineName: w.name || '',
    producer: w.producer || '',
    appellation: w.appellation || '',
    countryName: populatedName(w.country),
    regionName: populatedName(w.region),
    grapeNames: grapeSearchNames(w).join(', '),
    type: w.type || '',
    notes: bottle.notes || '',
    location: bottle.location || '',
    vintage,
  };
  return {
    id: String(bottle._id),
    values,
    fields: null, // tokenised lazily — a filter-only request never needs words
    facets: {
      type: values.type,
      countryName: values.countryName,
      regionName: values.regionName,
      appellation: values.appellation,
      vintage,
      countryId: refId(w.country),
      regionId: refId(w.region),
      grapeIds: (w.grapes || []).filter(Boolean).map(refId),
    },
    sort: {
      wineName: values.wineName,
      vintage,
      price: bottle.price || 0,
      rating: bottle.rating || 0,
      createdAt: bottle.createdAt ? Math.floor(new Date(bottle.createdAt).getTime() / 1000) : 0,
    },
  };
}

// Sort order as the index kept it: numbers (and strings that read as one —
// vintages) before other strings; strings trimmed and lower-cased.
function sortKey(value) {
  if (typeof value === 'number') return { num: value, str: null };
  const s = String(value).trim();
  const num = s !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : NaN;
  return Number.isFinite(num) ? { num, str: null } : { num: null, str: facetKey(s) };
}

function compareSortKeys(a, b) {
  if (a.num !== null && b.num !== null) return a.num - b.num;
  if (a.num !== null) return -1;
  if (b.num !== null) return 1;
  return a.str < b.str ? -1 : a.str > b.str ? 1 : 0;
}

function parseSort(sort) {
  if (!sort || typeof sort !== 'string') return null;
  const desc = sort.startsWith('-');
  const field = SORT_FIELDS[desc ? sort.slice(1) : sort];
  return field ? { field, dir: desc ? -1 : 1 } : null;
}

/**
 * The index's ranking rules, in its order: words matched, typos, proximity,
 * field — then the requested sort — then position in the field, exactness.
 * 0 means a tie (the caller breaks it by id, as the index did by its own ids).
 */
function compareHits(a, b, order) {
  if (a.rank && b.rank) {
    const r = (b.rank.bucket - a.rank.bucket)
      || (a.rank.typos - b.rank.typos)
      || (a.rank.proximity - b.rank.proximity)
      || (a.rank.attribute - b.rank.attribute);
    if (r) return r;
  }
  if (order) {
    const s = compareSortKeys(a.key, b.key) * order.dir;
    if (s) return s;
  }
  if (a.rank && b.rank) return (a.rank.position - b.rank.position) || (a.rank.exactness - b.rank.exactness);
  return 0;
}

// ── Scope, filters, facets ──────────────────────────────────────────────────

function scopeOf({ cellarId, cellarIds }) {
  const ids = Array.isArray(cellarIds) && cellarIds.length > 0 ? cellarIds : (cellarId ? [cellarId] : []);
  return [...new Set(ids.map(String).filter(isObjectId))];
}

function statusMatch(statusFilter) {
  if (statusFilter === 'active') return { status: { $nin: CONSUMED_STATUSES } };
  if (statusFilter === 'consumed') return { status: { $in: CONSUMED_STATUSES } };
  return {};
}

const splitList = (value) => String(value).split(',').map((v) => v.trim()).filter(Boolean);

/**
 * The structural filters as one predicate over a search document. Values are
 * validated like the index's filter builder did: an invalid value is ignored,
 * and a list with no valid value filters nothing.
 */
function buildFilter({ type, countryId, regionId, appellation, grapeIds, vintage }) {
  const tests = [];
  const setOf = (values) => (values.length > 0 ? new Set(values) : null);
  const types = type ? setOf(splitList(type).map((t) => t.toLowerCase()).filter((t) => VALID_TYPES.includes(t))) : null;
  if (types) tests.push((f) => types.has(f.type.toLowerCase()));
  const countries = countryId ? setOf(splitList(countryId).filter(isObjectId).map((v) => v.toLowerCase())) : null;
  if (countries) tests.push((f) => countries.has(f.countryId));
  const regions = regionId ? setOf(splitList(regionId).filter(isObjectId).map((v) => v.toLowerCase())) : null;
  if (regions) tests.push((f) => regions.has(f.regionId));
  const grapes = Array.isArray(grapeIds) ? setOf(grapeIds.map(String).filter(isObjectId).map((v) => v.toLowerCase())) : null;
  if (grapes) tests.push((f) => f.grapeIds.some((id) => grapes.has(id)));
  const apps = appellation ? setOf(splitList(appellation).map(facetKey)) : null;
  if (apps) tests.push((f) => apps.has(facetKey(f.appellation)));
  const vintages = vintage ? setOf(splitList(vintage).filter((v) => /^[A-Za-z0-9]+$/.test(v)).map(facetKey)) : null;
  if (vintages) tests.push((f) => vintages.has(facetKey(f.vintage)));
  return tests.length > 0 ? (facets) => tests.every((test) => test(facets)) : null;
}

/**
 * Facet counts over a set of (facets, count) entries. Values group the way
 * the index grouped them — trimmed and lower-cased, so "NV" and "Nv" are one
 * value (filters match either) — under the spelling most bottles use; empty
 * values are not counted.
 */
function countFacets(entries) {
  const groups = {};
  for (const name of FACETS) groups[name] = new Map();
  const add = (name, value, count) => {
    if (value === '' || value === undefined || value === null) return;
    const key = facetKey(value);
    if (key === '') return;
    let group = groups[name].get(key);
    if (!group) { group = { total: 0, spellings: new Map() }; groups[name].set(key, group); }
    group.total += count;
    const spelling = String(value);
    group.spellings.set(spelling, (group.spellings.get(spelling) || 0) + count);
  };
  for (const { facets, count } of entries) {
    for (const name of FACETS) {
      if (name === 'grapeIds') new Set(facets.grapeIds).forEach((id) => add(name, id, count));
      else add(name, facets[name], count);
    }
  }
  const out = {};
  for (const name of FACETS) {
    out[name] = {};
    for (const { total, spellings } of groups[name].values()) {
      let label = null;
      for (const [spelling, n] of spellings) if (label === null || n > spellings.get(label)) label = spelling;
      out[name][label] = total;
    }
  }
  return out;
}

/** Name → id maps for the filter modal (it shows names, filters by id). */
function facetMetaOf(wines) {
  const countries = {};
  const regions = {};
  const grapes = {};
  for (const w of wines.values()) {
    if (w.country && w.country.name && w.country._id) countries[w.country.name] = String(w.country._id);
    if (w.region && w.region.name && w.region._id) regions[w.region.name] = String(w.region._id);
    for (const g of w.grapes || []) {
      if (g && g.name && g._id) grapes[g.name] = String(g._id);
    }
  }
  return { countries, regions, grapes };
}

async function loadWines(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const wines = await WineDefinition.find({ _id: { $in: unique } })
    .select('name producer appellation type country region grapes')
    .populate('country', 'name')
    .populate('region', 'name')
    // regionalNames feed grapeSearchNames (regional display names match too).
    .populate('grapes', 'name regionalNames')
    .lean();
  return new Map(wines.map((w) => [String(w._id), w]));
}

const EMPTY_FACETS = () => countFacets([]);

function emptyResult() {
  return {
    ids: [],
    total: 0,
    facetDistribution: EMPTY_FACETS(),
    baseFacetDistribution: EMPTY_FACETS(),
    facetMeta: { countries: {}, regions: {}, grapes: {} },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search the bottles of the given cellars.
 *
 * The scope (`cellarId` or `cellarIds`) must already be access-checked by the
 * caller. No usable scope matches nothing — never every tenant's bottles
 * (security audit 2026-09-02, D10-5).
 *
 * @param {string} query free text; '' lists every bottle that passes the filters
 * @param {object} opts
 * @param {string} [opts.statusFilter='active'] 'active' | 'consumed' | 'all'
 * @param {string} [opts.type] comma-separated wine types
 * @param {string} [opts.countryId] comma-separated ids
 * @param {string} [opts.regionId] comma-separated ids
 * @param {string} [opts.appellation] comma-separated names
 * @param {string[]} [opts.grapeIds] any of these grapes
 * @param {string} [opts.vintage] comma-separated vintages
 * @param {string} [opts.sort] name | createdAt | vintage | price | rating, '-' for descending
 * @param {number} [opts.limit=30]
 * @param {number} [opts.offset=0]
 * @returns {Promise<{ ids: string[], total: number, facetDistribution: object,
 *   baseFacetDistribution: object, facetMeta: object }>} `ids` is the ranked
 *   page; `total` counts every hit; facetDistribution counts the hits,
 *   baseFacetDistribution the whole scope (what the filter modal lists).
 */
async function searchBottles(query, {
  cellarId,
  cellarIds,
  statusFilter = 'active',
  type,
  countryId,
  regionId,
  appellation,
  grapeIds,
  vintage,
  sort,
  limit = 30,
  offset = 0,
} = {}) {
  const scope = scopeOf({ cellarId, cellarIds });
  if (scope.length === 0) return emptyResult();

  const parsed = parseQuery(query);
  const bottles = await Bottle.find({ cellar: { $in: scope }, ...statusMatch(statusFilter) })
    .select(`_id wineDefinition vintage price rating createdAt${parsed ? ' notes location' : ''}`)
    .lean();
  const wines = await loadWines(bottles.map((b) => b.wineDefinition));
  const docs = bottles.map((b) => buildSearchDoc(b, b.wineDefinition ? wines.get(String(b.wineDefinition)) : null));

  const filter = buildFilter({ type, countryId, regionId, appellation, grapeIds, vintage });
  const candidates = filter ? docs.filter((d) => filter(d.facets)) : docs;

  let hits;
  if (parsed) {
    const memo = new Map();
    hits = [];
    for (const doc of candidates) {
      doc.fields = FIELDS.map((name) => tokenize(doc.values[name]));
      const rank = rankDocument(doc, parsed, memo);
      if (rank) hits.push({ doc, rank });
    }
  } else {
    hits = candidates.map((doc) => ({ doc, rank: null }));
  }

  const order = parseSort(sort);
  const keyed = hits.map((h) => ({ ...h, key: order ? sortKey(h.doc.sort[order.field]) : null }));
  keyed.sort((a, b) => compareHits(a, b, order) || (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0));

  const start = Math.max(0, Number(offset) || 0);
  const count = Math.max(0, Number(limit) || 0);
  return {
    ids: keyed.slice(start, start + count).map((h) => h.doc.id),
    total: keyed.length,
    facetDistribution: countFacets(keyed.map((h) => ({ facets: h.doc.facets, count: 1 }))),
    baseFacetDistribution: countFacets(docs.map((d) => ({ facets: d.facets, count: 1 }))),
    facetMeta: facetMetaOf(wines),
  };
}

/**
 * Facet counts for the cellars' bottles with no search or filter — the plain
 * cellar page. One grouping query instead of loading every bottle.
 *
 * @returns {Promise<{ facetDistribution: object, baseFacetDistribution: object, facetMeta: object }>}
 */
async function bottleFacets({ cellarId, cellarIds, statusFilter = 'active' } = {}) {
  const scope = scopeOf({ cellarId, cellarIds });
  if (scope.length === 0) {
    const { facetDistribution, baseFacetDistribution, facetMeta } = emptyResult();
    return { facetDistribution, baseFacetDistribution, facetMeta };
  }
  const { ObjectId } = mongoose.Types;
  const rows = await Bottle.aggregate([
    { $match: { cellar: { $in: scope.map((id) => new ObjectId(id)) }, ...statusMatch(statusFilter) } },
    { $group: { _id: { wine: '$wineDefinition', vintage: '$vintage' }, count: { $sum: 1 } } },
  ]);
  const wines = await loadWines(rows.map((r) => r._id.wine));
  const facetDistribution = countFacets(rows.map((r) => ({
    facets: buildSearchDoc({ _id: 'facet', vintage: r._id.vintage }, r._id.wine ? wines.get(String(r._id.wine)) : null).facets,
    count: r.count,
  })));
  return { facetDistribution, baseFacetDistribution: facetDistribution, facetMeta: facetMetaOf(wines) };
}

module.exports = {
  searchBottles,
  bottleFacets,
  // Exported for unit tests.
  _internal: {
    fold, toWords, tokenize, editDistance, matchWord, parseQuery, rankDocument, buildSearchDoc, countFacets,
    sortKey, parseSort, compareHits, FIELDS,
  },
};
