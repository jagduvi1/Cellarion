/**
 * Label sweetness — the term table and its readers (GitHub discussion #1754).
 *
 * Part 1 (this file today): the curated term rows (models/SweetnessTerm), an
 * in-memory copy the pickers, the MCP tool and the identity keys read, the
 * resolver from a printed word to a row, the output shapes every wine read
 * uses, and the boot seed. The WRITE rule — reading a term off a name, moving
 * the word out of the name, refusing an unknown word — follows in part 2; no
 * write path sets a term yet except the admin taxonomy screen.
 *
 * Same cache shape as services/classificationOps (60 s TTL, invalidated by the
 * admin routes, pinned in tests, EMPTY without a database connection so unit
 * tests need no mocks).
 */
const mongoose = require('mongoose');
const SweetnessTerm = require('../models/SweetnessTerm');
const { normalizeSweetnessTerm, appendSweetnessTerm } = require('../utils/normalize');

const { SCALES, BANDS } = SweetnessTerm;

/**
 * The scale a wine's terms live on, from its type. Fortified wines (Fino,
 * Medium, Cream, the Port styles) are a scale of their own and carry no term
 * for now; a drink that is not wine has none either. A wine with no type is
 * answered null too: the caller searches both scales and demands one hit.
 */
function scaleForType(type, { nonWine = false } = {}) {
  if (nonWine) return null;
  if (!type) return null;
  if (type === 'sparkling') return 'sparkling';
  if (type === 'fortified') return null;
  return 'still';
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

/** Admin taxonomy writes call this so the next read sees the change. */
function invalidateSweetnessCache() { cache = null; }

/** Tests: a fixed table, no database. Pass null to clear. */
function primeSweetnessCache(rows) { cache = rows ? indexTerms(rows, { pinned: true }) : null; }

/**
 * Pick the row for a word among the rows that spell it (sync, on a loaded
 * table). `scale` decides between "trocken" the still word and "trocken" the
 * Sekt word; without one, the word must exist on exactly one scale. A row of
 * the wine's country wins over a country-less one when both exist.
 */
function pickTerm(rows, { scale = null, countryId = null } = {}) {
  if (!rows || !rows.length) return null;
  let list = scale ? rows.filter((r) => r.scale === scale) : rows;
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
  const key = normalizeSweetnessTerm(text);
  if (!key) return null;
  const terms = await loadTerms();
  return pickTerm(terms.byKey.get(key), { scale, countryId });
}

/** The same, on a table the caller already loaded (the migration, a picker). */
function resolveLoaded(terms, text, opts = {}) {
  const key = normalizeSweetnessTerm(text);
  if (!key) return null;
  return pickTerm(terms.byKey.get(key), opts);
}

/**
 * A term row as every wine read sends it: { name, band, scale, regulated }.
 * The same shape on REST, MCP and the Bridge, keyed on `name` like the
 * classification rows ({ name, kind }) beside it.
 */
function termOut(row) {
  if (!row || typeof row !== 'object' || !row.name) return null;
  return { name: row.name, band: row.band, scale: row.scale, regulated: row.regulated !== false };
}

/**
 * A wine's label sweetness for the API, when its term was populated; null
 * when the wine has none. An id-only ref (an unpopulated read) answers null
 * too, as classificationsOut answers [] — the surface did not carry it.
 */
function labelSweetnessOut(wd) {
  return termOut(wd && wd.labelSweetness);
}

/** The populated term's name, or null — the form the display name and the identity keys read. */
function termNameOf(wd) {
  const t = wd && wd.labelSweetness;
  if (!t) return null;
  if (typeof t === 'string') return t;
  return typeof t === 'object' && typeof t.name === 'string' ? t.name : null;
}

/**
 * The name as the label reads: the name, then the term — unless the name
 * already carries the word (a wine marked sweetnessInName, "Brut Premier").
 * Every TEXT surface (MCP summaries, exports, the Bridge to an older server,
 * search documents) shows this; structured readers get `labelSweetness`.
 */
function wineDisplayName(wd) {
  if (!wd) return '';
  return appendSweetnessTerm(wd.name, termNameOf(wd));
}

/** Upsert the seed rows from data/sweetness-terms.json; returns { created, updated }. */
async function seedSweetnessTerms({ seed = require('../data/sweetness-terms.json') } = {}) {
  let created = 0; let updated = 0;
  for (const s of seed) {
    const normalizedName = normalizeSweetnessTerm(s.name);
    const existing = await SweetnessTerm.findOne({ normalizedName, scale: s.scale });
    const fields = {
      name: s.name, scale: s.scale, band: s.band, system: s.system || null, country: null,
      regulated: s.regulated !== false, synonyms: s.synonyms || [], description: s.description || '', reviewedAt: new Date(),
    };
    if (existing) {
      const merged = [...new Set([...(existing.synonyms || []), ...fields.synonyms])];
      Object.assign(existing, { ...fields, country: existing.country, synonyms: merged, reviewedAt: existing.reviewedAt || fields.reviewedAt });
      await existing.save(); updated += 1;
    } else {
      await SweetnessTerm.create({ ...fields, normalizedName, createdByUser: false });
      created += 1;
    }
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
  loadTerms, invalidateSweetnessCache, primeSweetnessCache,
  resolveTerm, resolveLoaded, pickTerm,
  termOut, labelSweetnessOut, termNameOf, wineDisplayName,
  seedSweetnessTerms, ensureSweetnessSeed,
};
