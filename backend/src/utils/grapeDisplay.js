/**
 * Regional display names for grapes (somm ticket: "Tinta Roriz stored as
 * Tempranillo on a Douro Port").
 *
 * Wines reference ONE canonical Grape doc — storage, dedup, search facets,
 * stats and pairing all keep a single vocabulary. What varies by place is the
 * LABEL: the same variety is "Tinta Roriz" on a Douro Port and "Aragonez" on
 * an Alentejo red. Grape.regionalNames carries those aliases; this util
 * resolves the right one for a wine's own country/region at serialize time.
 * Display-only: nothing here writes, and matching typed input to a grape
 * stays the job of Grape.synonyms/normalizedSynonyms.
 */

/**
 * String id of an ObjectId, hex string, or populated doc ({ _id }); null when
 * absent. Ids are compared as strings so lean docs, populated refs and raw
 * ObjectIds interoperate. An object we cannot identify (e.g. a projected doc
 * missing _id) yields null — never "[object Object]", which two different
 * docs would "share" and falsely match on.
 */
function idOf(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return value.toHexString(); // ObjectId
    if (value._id != null) return String(value._id); // populated doc
    return null;
  }
  const s = String(value);
  return s || null;
}

/**
 * Resolve the display name for one grape in one wine's context.
 *
 * Most-specific-wins:
 *   1. an entry whose region matches the wine's region (and whose country
 *      matches the wine's country);
 *   2. else an entry with NO region whose country matches;
 *   3. else the canonical `grape.name`.
 *
 * Null-safe on every field: a grape without regionalNames, or a wine without
 * a country, resolves to the canonical name. Entries with a blank name are
 * skipped rather than blanking the display.
 *
 * @param {object} grape                – Grape doc/lean object ({ name, regionalNames? })
 * @param {object} [ctx]
 * @param {*}      [ctx.countryId]      – wine's country (id, hex string, or populated doc)
 * @param {*}      [ctx.regionId]       – wine's region (id, hex string, or populated doc)
 * @returns {string|null} the display name, or null when grape is missing
 */
function resolveGrapeDisplayName(grape, { countryId, regionId } = {}) {
  if (!grape) return null;
  const canonical = grape.name || null;
  const entries = Array.isArray(grape.regionalNames) ? grape.regionalNames : [];
  if (entries.length === 0) return canonical;

  const wineCountry = idOf(countryId);
  const wineRegion = idOf(regionId);
  // Every entry carries a country, so a wine without one can never match.
  if (!wineCountry) return canonical;

  let countryLevelMatch = null;
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    if (idOf(entry.country) !== wineCountry) continue;
    const entryRegion = idOf(entry.region);
    if (entryRegion) {
      // Region-level entry: most specific — first hit wins outright.
      if (wineRegion && entryRegion === wineRegion) return entry.name;
    } else if (!countryLevelMatch) {
      countryLevelMatch = entry.name;
    }
  }
  return countryLevelMatch || canonical;
}

/**
 * Decorate a wine's populated grapes with `displayName`, resolved against the
 * wine's own country/region. Returns a plain-object copy (Mongoose docs go
 * through toObject(), lean objects are shallow-copied) — the input is never
 * mutated and `name` always stays the canonical variety, so callers that
 * store or match on `name` are unaffected.
 *
 * Null-safe: a missing wine passes through, wines without grapes are returned
 * unchanged, and grapes that are bare ObjectIds (caller didn't populate) are
 * left as-is rather than decorated with garbage.
 *
 * @param {object} wine – wine doc/lean object with populated `grapes` and
 *                        `country`/`region` as ids or populated docs
 * @returns {object} the decorated copy (or the input when falsy)
 */
function decorateGrapes(wine) {
  if (!wine) return wine;
  const out = typeof wine.toObject === 'function' ? wine.toObject() : { ...wine };
  if (!Array.isArray(out.grapes) || out.grapes.length === 0) return out;
  const ctx = { countryId: out.country, regionId: out.region };
  out.grapes = out.grapes.map((g) => {
    if (!g || typeof g !== 'object' || !g.name) return g; // unpopulated ref — leave untouched
    const plain = typeof g.toObject === 'function' ? g.toObject() : { ...g };
    plain.displayName = resolveGrapeDisplayName(plain, ctx) || plain.name;
    return plain;
  });
  return out;
}

module.exports = { resolveGrapeDisplayName, decorateGrapes };
