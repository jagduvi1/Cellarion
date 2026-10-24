/**
 * Grape name claims — which variety a string answers to.
 *
 * The wine write path (services/wineProfileOps resolveGrapeIdsStrict) folds a
 * grape name through the static alias map (utils/normalize GRAPE_SYNONYMS:
 * "Shiraz" → Syrah, "Primitivo" → Zinfandel) BEFORE it looks the variety up by
 * normalizedName / normalizedSynonyms. Every tool that creates or edits a
 * grape row checks its claims with that same fold, so a row the resolver can
 * never reach (a "Shiraz" twin of Syrah) is not created, and a lookup by
 * alias finds the variety a wine write would find.
 */
const { normalizeString, resolveGrapeName } = require('../utils/normalize');

/** The key a grape string resolves under — the wine write path's fold. */
const claimKey = (s) => normalizeString(resolveGrapeName(s));

/**
 * The grape row (other than `excludeId`) that already answers to any of
 * `strings` by name or synonym, or null when none does.
 *
 * @param {string[]} strings  names / synonyms the caller wants to claim
 * @param {{excludeId?: any}} [opts]  the row being edited, which may keep its own claims
 * @returns {Promise<{name:string, synonyms?:string[]}|null>}
 */
async function findGrapeClaim(strings, { excludeId } = {}) {
  const keys = [...new Set((strings || []).map(claimKey).filter(Boolean))];
  if (!keys.length) return null;
  // Lazy: claimKey stays importable without the model layer.
  const Grape = require('../models/Grape');
  return Grape.findOne({
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    $or: [{ normalizedName: { $in: keys } }, { normalizedSynonyms: { $in: keys } }],
  }).select('name synonyms').lean();
}

module.exports = { claimKey, findGrapeClaim };
