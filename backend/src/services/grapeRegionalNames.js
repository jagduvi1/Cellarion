/**
 * Grape regional display names — the validators every write surface runs.
 *
 * Kept out of the admin router so a caller that is not a route (an MCP tool,
 * a script) can use them without requiring a route module and the admin
 * router tree it loads. routes/admin/taxonomy.js requires them from here.
 */
const Country = require('../models/Country');
const Region = require('../models/Region');
const { isValidId } = require('../utils/validation');
const { sanitizeTaxonomyName, normalizeString, resolveGrapeName } = require('../utils/normalize');

// ── Regional display names validation ────────────────────────────────────────
// Grape.regionalNames = [{ country, region?, name }] — regionally correct
// display labels ("Tinta Roriz" for Tempranillo on Douro wines; see
// models/Grape.js). Bounded and ref-checked here because Mongoose validates
// neither that the ids exist nor that the region belongs to the country.
const REGIONAL_NAMES_MAX = 20;
const REGIONAL_NAME_MAX_LENGTH = 60; // == the schema's maxlength

/**
 * Validate a regionalNames payload. Returns { error } (human-readable, safe
 * for a 400 body) or { value } — the cleaned array: trimmed names, ids as
 * strings, region null when absent.
 *
 * Same discipline as taxonomyReview.appellationRefsError: every id is
 * isValidId-checked and the validated STRING is what reaches the query, so
 * operator objects from the request body never enter a filter.
 */
async function validateGrapeRegionalNames(input) {
  if (!Array.isArray(input)) {
    return { error: 'regionalNames must be an array of { country, region?, name } entries' };
  }
  if (input.length > REGIONAL_NAMES_MAX) {
    return { error: `At most ${REGIONAL_NAMES_MAX} regional names per grape` };
  }
  const value = [];
  const seenPairs = new Set();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'regionalNames must be an array of { country, region?, name } entries' };
    }
    // Same bounding grape.name gets (utils/normalize): control characters
    // become spaces, whitespace collapses, length is capped — a regional name
    // is substituted into the same display/search surfaces, so a newline or a
    // zero-width char must not survive here either (returns '' for
    // non-strings, which the emptiness check below rejects).
    const name = sanitizeTaxonomyName(entry.name);
    if (!name) return { error: 'Each regional name needs a non-empty name' };
    if (name.length > REGIONAL_NAME_MAX_LENGTH) {
      return { error: `Regional names must be ${REGIONAL_NAME_MAX_LENGTH} characters or fewer` };
    }
    const countryKey = String(entry.country ?? '');
    if (!isValidId(countryKey)) return { error: 'Each regional name needs a valid country id' };
    const countryExists = await Country.exists({ _id: countryKey });
    if (!countryExists) return { error: 'No country with that id' };
    let regionKey = null;
    if (entry.region) {
      regionKey = String(entry.region);
      if (!isValidId(regionKey)) return { error: 'Invalid region id in regional names' };
      const region = await Region.findById(regionKey).select('name country').lean();
      if (!region) return { error: 'No region with that id' };
      if (String(region.country) !== countryKey) {
        return { error: `Region "${region.name}" belongs to a different country than the regional name's country` };
      }
    }
    // One display name per place — a duplicate (country, region) pair would
    // make resolution order-dependent.
    const pairKey = `${countryKey}:${regionKey || ''}`;
    if (seenPairs.has(pairKey)) {
      return { error: 'Duplicate (country, region) pair in regional names — each place carries one display name' };
    }
    seenPairs.add(pairKey);
    value.push({ country: countryKey, region: regionKey, name });
  }
  return { value };
}

/**
 * Curator-trap check: a regional name that is NOT also a synonym of its grape
 * DISPLAYS fine, but cannot be written back — a curator reading "Tinta Roriz"
 * off a wine card and typing it into set_wine_profile gets "unknown variety",
 * because resolveGrapeIdsStrict matches normalizedName + normalizedSynonyms
 * only. Runs the exact fold that write path runs
 * (normalizeString(resolveGrapeName(name))) against the grape AS IT WILL BE
 * SAVED. Non-blocking by house doctrine — a display name is legitimate
 * without being a synonym; flag, never block.
 *
 * @param {Array<{name:string}>} entries  validated regionalNames
 * @param {{name:string, normalizedName:string, synonyms?:string[]}} grape
 *        effective fields (incoming values win over the stored doc's)
 * @returns {string[]} one warning per non-writable name; [] when all write back
 */
function computeRegionalNameWarnings(entries, { name, normalizedName, synonyms }) {
  const writable = new Set(
    [normalizedName, ...(synonyms || []).map(normalizeString)].filter(Boolean)
  );
  const warnings = [];
  for (const entry of entries) {
    const key = normalizeString(resolveGrapeName(entry.name));
    if (key && writable.has(key)) continue;
    warnings.push(
      `'${entry.name}' is not a synonym of ${name} — curators cannot write it back via set_wine_profile; add it as a synonym too`
    );
  }
  return warnings;
}

module.exports = {
  REGIONAL_NAMES_MAX,
  REGIONAL_NAME_MAX_LENGTH,
  validateGrapeRegionalNames,
  computeRegionalNameWarnings,
};
