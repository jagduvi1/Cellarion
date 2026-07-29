/**
 * Canonical appellation SPELLING at mint time (registry strategy 2026-07-29,
 * R2 — the write-time half; the seed script and the unmatched review queue
 * are the other halves).
 *
 * Wines store the appellation as a free string, and `appellation_wrong` was
 * the single largest category of the 2026-07-26 registry audit (231 rows):
 * with no membership list, every writer invents its own spelling and every
 * rule that reasons about appellations has to guess grammatically (the
 * "Clairette de Die" false positive — "Die" read as a German article instead
 * of the Drôme town, PR #850).
 *
 * This resolver is the Grape treatment, not the Country treatment: when the
 * typed appellation matches a curated Appellation doc (by normalized name or
 * synonym), the doc's canonical display spelling is adopted — so variants
 * collapse into ONE string on wines and the membership list actually governs
 * what the registry shows. When nothing matches, the free text is kept
 * verbatim: appellations are genuinely open-ended (new AVAs and DOCs appear,
 * and oddities like "Vin de France" are legitimate), so an unknown value is
 * REVIEWED (admin unmatched queue), never rejected — a user adding a bottle
 * must not be blocked by taxonomy.
 */
const Appellation = require('../models/Appellation');
const { normalizeString } = require('../utils/normalize');

/**
 * @param {string} rawAppellation  tier-stripped, trimmed appellation string
 * @returns {Promise<string>} canonical spelling when curated, else the input.
 *   Never throws — on lookup failure the input is kept; a mint must not fail
 *   over taxonomy.
 */
async function resolveCanonicalAppellation(rawAppellation) {
  if (!rawAppellation) return rawAppellation;
  const normalized = normalizeString(rawAppellation);
  if (!normalized) return rawAppellation;
  try {
    // limit(2): one match → adopt. Two docs can share a name across countries
    // (the unique index is per-country); adopt only when their display
    // spellings agree — when even the curated docs disagree, the typed
    // spelling is not obviously wrong and is left alone.
    const docs = await Appellation.find({
      $or: [{ normalizedName: normalized }, { normalizedSynonyms: normalized }],
    }).select('name').limit(2).lean();
    if (docs.length === 0) return rawAppellation;
    if (docs.length === 1 || docs[0].name === docs[1].name) return docs[0].name;
    return rawAppellation;
  } catch (err) {
    console.warn('[appellationResolve] lookup failed (non-fatal, keeping input):', err.message);
    return rawAppellation;
  }
}

module.exports = { resolveCanonicalAppellation };
