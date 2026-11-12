/**
 * Label sweetness — the term table and its readers (GitHub discussion #1754).
 *
 * This file: the curated term rows (models/SweetnessTerm), an in-memory copy
 * the pickers, the MCP tool, the style guard and the identity keys read, the
 * resolver from a printed word to a row, the output shapes every wine read
 * uses, and the boot seed. The WRITE rule — reading a term off a name, moving
 * the word out of the name, refusing an unknown word — is
 * services/sweetnessWrite, which no write path calls yet: the one path that
 * sets a wine's term is a Registry Bridge copy (services/registryBridge).
 *
 * Same cache shape as services/classificationOps (60 s TTL, invalidated by the
 * admin routes, pinned in tests, EMPTY without a database connection so unit
 * tests need no mocks).
 */
const mongoose = require('mongoose');
const SweetnessTerm = require('../models/SweetnessTerm');
const { logger } = require('./audit');
const { normalizeSweetnessTerm, appendSweetnessTerm } = require('../utils/normalize');

const { SCALES, BANDS } = SweetnessTerm;

/**
 * The scale a wine's terms live on, from its type:
 *   'sparkling' | 'still'  — the scale;
 *   false                  — NO scale applies: a fortified wine (Fino, Medium,
 *                            Cream, the Port styles are a scale of their own and
 *                            carry no term for now) or a drink that is not wine;
 *   null                   — unknown: a wine with no type. The caller searches
 *                            both scales and demands one hit.
 */
function scaleForType(type, { nonWine = false } = {}) {
  if (nonWine) return false;
  if (type === 'fortified') return false;
  if (!type) return null;
  return type === 'sparkling' ? 'sparkling' : 'still';
}

const TERMS_TTL_MS = 60 * 1000;
const TERMS_SELECT = 'name normalizedName scale band system country regulated synonyms normalizedSynonyms createdByUser reviewedAt';
let cache = null; // { at, pinned, rows, byId, byKey, empty }

function indexTerms(rows, { pinned = false } = {}) {
  const byId = new Map();
  const byKey = new Map(); // normalised word → rows (one per scale at most, plus synonyms)
  const add = (k, row) => { if (!k) return; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(row); };
  for (const r of rows) {
    const row = {
      ...r,
      regulated: r.regulated !== false,
      normalizedName: r.normalizedName || normalizeSweetnessTerm(r.name),
      normalizedSynonyms: r.normalizedSynonyms || (r.synonyms || []).map(normalizeSweetnessTerm).filter(Boolean),
    };
    byId.set(String(row._id), row);
    add(row.normalizedName, row);
    for (const s of row.normalizedSynonyms) add(s, row);
  }
  return { at: Date.now(), pinned, rows, byId, byKey, empty: rows.length === 0 };
}

/**
 * The term table, cached for a minute. Without a live connection (tests, a
 * boot before the seed ran) it is empty and nothing resolves.
 */
async function loadTerms() {
  if (cache && (cache.pinned || Date.now() - cache.at < TERMS_TTL_MS)) return cache;
  if (mongoose.connection.readyState !== 1) return indexTerms([]);
  const rows = await SweetnessTerm.find({}).select(TERMS_SELECT).lean();
  cache = indexTerms(rows);
  return cache;
}

/**
 * Admin taxonomy writes call this so the next read sees the change. The copy
 * is expired, never dropped: the synchronous readers (the display name and
 * the slug's spellings, the style guard) keep the last table — a cold copy
 * would make them forget every synonym — until the reload, started here.
 */
function invalidateSweetnessCache() {
  if (!cache) return;
  cache = { ...cache, at: 0, pinned: false };
  if (mongoose.connection.readyState !== 1) return;
  loadTerms().catch((err) => logger.warn({ err: err.message }, 'sweetness term table reload failed'));
}

/** Tests: a fixed table, no database. Pass null to clear. */
function primeSweetnessCache(rows) { cache = rows ? indexTerms(rows, { pinned: true }) : null; }

/**
 * A term row by id from the in-memory copy, synchronously, WHEN the copy is
 * warm — null otherwise (never a read). For the readers that meet an
 * unpopulated ref and may not do I/O: the style guard, a summary built from a
 * row a caller loaded without the populate. A belt, not the braces: every
 * surface still populates the term where it reads a wine.
 */
function cachedTerm(id) {
  if (!cache || id == null) return null;
  return cache.byId.get(String(id)) || null;
}
function cachedTermName(id) {
  const row = cachedTerm(id);
  return row ? row.name : null;
}

/**
 * Pick the row for a word among the rows that spell it (sync, on a loaded
 * table). `scale` decides between "trocken" the still word and "Trocken" the
 * Sekt word; `false` means no scale applies (fortified) and nothing resolves;
 * null (unknown type) demands the word exist on exactly one scale. A row of
 * the wine's country wins over a country-less one when both exist.
 */
function pickTerm(rows, { scale = null, countryId = null } = {}) {
  if (scale === false) return null;
  if (!rows || !rows.length) return null;
  const list = scale ? rows.filter((r) => r.scale === scale) : rows;
  if (!scale) {
    const scales = new Set(list.map((r) => r.scale));
    if (scales.size !== 1) return null;
  }
  if (!list.length) return null;
  if (countryId) {
    const own = list.find((r) => r.country && String(r.country._id || r.country) === String(countryId));
    if (own) return own;
  }
  return list.find((r) => !r.country) || list[0];
}

/** Resolve a printed word (or an accepted spelling) to its term row, or null. */
async function resolveTerm(text, { scale = null, countryId = null } = {}) {
  if (scale === false) return null;
  const key = normalizeSweetnessTerm(text);
  if (!key) return null;
  const terms = await loadTerms();
  return pickTerm(terms.byKey.get(key), { scale, countryId });
}

/** The same, on a table the caller already loaded (the migration, a picker). */
function resolveLoaded(terms, text, opts = {}) {
  if (opts.scale === false) return null;
  const key = normalizeSweetnessTerm(text);
  if (!key) return null;
  return pickTerm(terms.byKey.get(key), opts);
}

/**
 * A term row as every wine read sends it: { name, band, scale, regulated }.
 * The same shape on REST, MCP and the Bridge, keyed on `name` like the
 * classification rows ({ name, kind }) beside it; the row's country stays in
 * the vocabulary listing (list_sweetness_terms), not on the wine.
 */
function termOut(row) {
  if (!row || typeof row !== 'object' || typeof row.name !== 'string' || !row.name) return null;
  return { name: row.name, band: row.band, scale: row.scale, regulated: row.regulated !== false };
}

const ID_RX = /^[0-9a-f]{24}$/i;
/**
 * The term row a wine carries, as the read left it: the populated row, or —
 * for an unpopulated ref — the in-memory copy's row when it is warm. Never a
 * bare string as a word: a string here is an id or nothing. Returns
 * `undefined` when the read did not load the field at all, null when the wine
 * has none, and the row otherwise; `unresolved` when an id could not be read.
 */
function termRowOf(wd) {
  if (!wd || wd.labelSweetness === undefined) return undefined;
  const t = wd.labelSweetness;
  if (t === null) return null;
  if (typeof t === 'object' && typeof t.name === 'string' && t.name) return t;
  const id = typeof t === 'string' ? t : (t && typeof t.toString === 'function' ? t.toString() : '');
  // Anything that is neither a row nor an id (a bare word, say) is nothing the
  // record can vouch for: unresolved, never "no term".
  if (!ID_RX.test(id)) return 'unresolved';
  return cachedTerm(id) || 'unresolved';
}

/**
 * A wine's label sweetness for a serializer that always loads the field
 * (REST, the Bridge): { name, band, scale, regulated } or null.
 */
function labelSweetnessOut(wd) {
  const row = termRowOf(wd);
  return row && row !== 'unresolved' ? termOut(row) : null;
}

/**
 * The term's name, or null — the form the identity keys read — for a caller
 * that may do I/O and holds an unpopulated ref: the
 * populated row's or the warm copy's name at once, else one load of the term
 * table. For the key a writer builds beside the hook (a reserved key in a
 * rename plan, a clash check) — never a bare key over a termed wine.
 */
async function termNameForWine(wd) {
  const row = termRowOf(wd);
  if (row && row !== 'unresolved') return row.name;
  if (row !== 'unresolved') return null;
  const t = wd.labelSweetness;
  const id = typeof t === 'string' ? t : (t && typeof t.toString === 'function' ? t.toString() : '');
  if (!ID_RX.test(id)) return null;
  const terms = await loadTerms();
  return terms.byId.get(id)?.name || null;
}

/**
 * The name as the label reads: the name, then the term — unless the name
 * already carries the word (a wine marked sweetnessInName, "Brut Premier").
 * Every TEXT surface (MCP summaries, exports, the Bridge to an older server,
 * search documents) shows this; structured readers get `labelSweetness`.
 * The stored casing is kept: still-wine words are lowercase, sparkling
 * designations capitalised (data/sweetness-terms.json).
 */
function wineDisplayName(wd) {
  if (!wd) return '';
  const row = termRowOf(wd);
  return appendSweetnessTerm(wd.name, row && row !== 'unresolved' ? termSpellings(row) : null);
}

/**
 * Every spelling of a term row — its name first, then its synonyms — for the
 * "does the name already carry it" test of the display name. A row read in
 * the API shape has no synonyms: the warm in-memory copy supplies them (by
 * id, else by word and scale), and a cold one leaves the name alone.
 */
function termSpellings(row) {
  if (!row || typeof row.name !== 'string' || !row.name) return null;
  if (Array.isArray(row.synonyms)) return [row.name, ...row.synonyms];
  const known = (cache && row._id != null && cache.byId.get(String(row._id)))
    || (cache && (cache.byKey.get(normalizeSweetnessTerm(row.name)) || [])
      .find((r) => r.name === row.name && (!row.scale || r.scale === row.scale)));
  return known ? [row.name, ...(known.synonyms || [])] : [row.name];
}

/**
 * The MCP fields for a wine, emitted HONESTLY or not at all (the grapes rule
 * in mcp/tools/somm.js), decided by the caller's PROJECTION, not by what the
 * stored row happens to hold:
 *
 *   loaded: true  — the caller selected (and populated) the field. A row that
 *                   predates the field has no key at all (a lean read applies
 *                   no defaults; thousands of rows are like that), and it means
 *                   the same as null: the wine states no term. So:
 *                   { label_sweetness: row | null, display_name }.
 *   loaded: false — the caller did not load the field: neither key, so a
 *                   missing key means "not carried on this surface".
 *
 * A ref the in-memory copy cannot name says nothing either way.
 */
function labelSweetnessFields(wd, { loaded = false } = {}) {
  if (!wd) return {};
  const row = termRowOf(wd);
  if (row === 'unresolved') return {};
  if (row === undefined && !loaded) return {};
  const term = row || null;
  return { label_sweetness: termOut(term), display_name: appendSweetnessTerm(wd.name, term ? termSpellings(term) : null) };
}

/**
 * Seed the rows from data/sweetness-terms.json; returns { created, updated }.
 * A row that exists (same word, same scale) is brought up to date and keeps
 * its country and any synonyms an admin added; a missing one is inserted with
 * an upsert, so two replicas seeding at once write it once.
 */
async function seedSweetnessTerms({ seed = require('../data/sweetness-terms.json') } = {}) {
  let created = 0; let updated = 0;
  for (const s of seed) {
    const normalizedName = normalizeSweetnessTerm(s.name);
    const synonyms = s.synonyms || [];
    const fields = {
      name: s.name, scale: s.scale, band: s.band, system: s.system || null,
      regulated: s.regulated !== false, synonyms, description: s.description || '',
    };
    const existing = await SweetnessTerm.findOne({ normalizedName, scale: s.scale });
    if (existing) {
      const merged = [...new Set([...(existing.synonyms || []), ...synonyms])];
      Object.assign(existing, { ...fields, synonyms: merged, reviewedAt: existing.reviewedAt || new Date() });
      await existing.save(); updated += 1;
      continue;
    }
    const r = await SweetnessTerm.updateOne(
      { normalizedName, scale: s.scale },
      {
        $setOnInsert: {
          ...fields, normalizedName, country: null,
          normalizedSynonyms: synonyms.map(normalizeSweetnessTerm).filter(Boolean),
          createdByUser: false, reviewedAt: new Date(), createdAt: new Date(),
        },
      },
      { upsert: true }
    );
    if (r && r.upsertedCount) created += 1;
  }
  invalidateSweetnessCache();
  return { created, updated };
}

/**
 * Boot: a registry with no term rows at all gets the seed, so a fresh install
 * (or one upgraded past this feature) has the vocabulary the pickers and the
 * write rule resolve against. A registry with rows keeps exactly what its
 * admin chose. Idempotent, cheap when rows exist.
 */
async function ensureSweetnessSeed() {
  const n = await SweetnessTerm.estimatedDocumentCount();
  if (n > 0) return { seeded: false };
  const r = await seedSweetnessTerms();
  return { seeded: true, ...r };
}

module.exports = {
  SCALES, BANDS, scaleForType,
  loadTerms, invalidateSweetnessCache, primeSweetnessCache, cachedTerm, cachedTermName,
  resolveTerm, resolveLoaded,
  labelSweetnessOut, labelSweetnessFields, termNameForWine, wineDisplayName,
  ensureSweetnessSeed,
};
