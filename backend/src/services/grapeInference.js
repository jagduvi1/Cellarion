// Infer a wine's grape varieties from its NAME when none were supplied.
//
// Ticket #2A: many registry wines carry the grape explicitly in the name
// ("Felton Road Block 3 Pinot Noir", "Bannockburn Chardonnay") yet have an
// empty grapes[] array, so they silently drop out of the Statistics "by grape"
// breakdown and the /api/wines?grapes= filter. Grapes are only ever set from
// the caller-supplied arg in findOrCreateWine — there is no name inference.
//
// This matches grape SURFACE FORMS (canonical names + admin synonyms + the
// global GRAPE_SYNONYMS map) against the normalized name, and only ever tags
// grapes that ALREADY EXIST in the taxonomy — it never mints a new Grape doc.
//
// Safety (the two traps a naive scan falls into):
//   1. Longest-first with span consumption: "Cabernet Sauvignon" is matched as
//      itself and its span is blanked out, so the bare "sauvignon" → Sauvignon
//      Blanc synonym can never also fire on the same wine. Same for
//      Pinot Noir/Gris/Blanc, Cabernet Franc/Sauvignon.
//   2. Word-boundary matching + a minimum surface-form length, so short
//      synonyms ("cot" → Malbec) can't match a substring of an unrelated word.
//
// The appellation fallback is deliberately tiny: only LEGALLY mono-varietal
// appellations, keyed on the place name with the tier suffix (DOCG/DOC/…)
// stripped. NOT Rioja (white = Viura, reds blend), Sancerre (rouge = Pinot
// Noir), Chianti (a blend) — those would mis-tag.

const { normalizeString, GRAPE_SYNONYMS } = require('../utils/normalize');

// Surface forms shorter than this are skipped for name matching — avoids the
// 3–4 char synonyms ("cot", "cote") that collide with substrings of real words.
const MIN_FORM_LEN = 5;

// Never tag more than this many grapes from one name — a guard against a
// pathological name that happens to contain many varietal words.
const MAX_INFERRED = 4;

// Place name (tier suffix stripped) → the single variety that appellation is
// by law. Conservative: only appellations that are mono-varietal in the colour
// their wines are made. Keyed on normalizeString(placeName).
const APPELLATION_GRAPE = {
  barolo: 'Nebbiolo',
  barbaresco: 'Nebbiolo',
  chablis: 'Chardonnay',
};

const TIER_SUFFIX_RX = /\b(docg|doca|doc|aoc|aop|ava|igt|igp|do|ao)\b/g;

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the longest-first list of grape surface forms from the grape corpus.
 * @param {Array<{_id:any,name:string,normalizedName?:string,normalizedSynonyms?:string[]}>} grapeDocs
 * @returns {Array<{form:string, grapeId:any, canonical:string}>}
 */
function buildSurfaceForms(grapeDocs) {
  const forms = [];
  const byNormName = new Map();
  const push = (grape, raw) => {
    const form = normalizeString(raw);
    if (form.length < MIN_FORM_LEN) return;
    forms.push({ form, grapeId: grape._id, canonical: grape.name });
  };
  for (const g of grapeDocs || []) {
    const nn = g.normalizedName || normalizeString(g.name);
    if (nn) byNormName.set(nn, g);
    push(g, g.name);
    for (const s of (g.normalizedSynonyms || [])) push(g, s);
  }
  // Global synonym map — attach each synonym to its canonical grape's doc, so
  // "Shiraz" → Syrah / "Primitivo" → Zinfandel are matchable even when a doc
  // carries no admin synonyms.
  for (const [syn, canonical] of Object.entries(GRAPE_SYNONYMS)) {
    const g = byNormName.get(normalizeString(canonical));
    if (g) push(g, syn);
  }
  // Longest first so multi-word forms win and consume their span before any
  // shorter form (single tokens) can match inside them.
  forms.sort((a, b) => b.form.length - a.form.length);
  return forms;
}

/**
 * Infer grape _ids from a wine name (with an optional appellation fallback).
 * @param {string} name         wine name (ideally producer already stripped)
 * @param {string} appellation  optional appellation string
 * @param {Array} surfaceForms  from buildSurfaceForms()
 * @returns {Array} grape _ids (may be empty)
 */
function inferGrapeIds(name, appellation, surfaceForms) {
  let work = ` ${normalizeString(name)} `;
  const ids = [];
  const seen = new Set();
  for (const { form, grapeId } of surfaceForms) {
    if (ids.length >= MAX_INFERRED) break;
    const boundary = new RegExp(`\\b${escapeRx(form)}\\b`);
    if (!boundary.test(work)) continue;
    const key = String(grapeId);
    if (!seen.has(key)) {
      seen.add(key);
      ids.push(grapeId);
    }
    // Blank every occurrence of this span so shorter overlapping forms (e.g.
    // "sauvignon" inside a just-matched "cabernet sauvignon") cannot re-match.
    work = work.replace(new RegExp(`\\b${escapeRx(form)}\\b`, 'g'), ' '.repeat(form.length));
  }

  // Appellation fallback — only when the name yielded nothing, and only for the
  // hand-picked mono-varietal appellations.
  if (ids.length === 0 && appellation) {
    const place = normalizeString(appellation).replace(TIER_SUFFIX_RX, '').replace(/\s+/g, ' ').trim();
    const canonical = APPELLATION_GRAPE[place];
    if (canonical) {
      const match = surfaceForms.find((f) => normalizeString(f.canonical) === normalizeString(canonical));
      if (match) ids.push(match.grapeId);
    }
  }
  return ids;
}

module.exports = { buildSurfaceForms, inferGrapeIds, MIN_FORM_LEN, MAX_INFERRED, APPELLATION_GRAPE };
