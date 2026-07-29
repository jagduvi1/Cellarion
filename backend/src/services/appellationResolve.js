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
const { normalizeAppellationKey } = require('../utils/normalize');

/**
 * @param {string} rawAppellation  tier-stripped, trimmed appellation string
 * @returns {Promise<string>} canonical spelling when curated, else the input.
 *   Never throws — on lookup failure the input is kept; a mint must not fail
 *   over taxonomy.
 */
async function resolveCanonicalAppellation(rawAppellation) {
  if (!rawAppellation) return rawAppellation;
  const normalized = normalizeAppellationKey(rawAppellation);
  if (!normalized) return rawAppellation;
  try {
    // Docs can share a name across countries (the unique index is per-country);
    // adopt only when EVERY curated doc agrees on the display spelling — when
    // even the curated docs disagree, the typed spelling is not obviously
    // wrong and is left alone. limit(4) with an agree-all check (audit
    // 2026-07-29 A5: limit(2) could see two agreeing docs and miss a third
    // that disagrees); .sort keeps the answer deterministic across query
    // plans. Adoption is re-capped at 200 chars — the doc name is admin
    // input with its own validation, but the mint chokepoint's field cap must
    // hold regardless of where the string came from (audit A1).
    const docs = await Appellation.find({
      $or: [{ normalizedName: normalized }, { normalizedSynonyms: normalized }],
    }).select('name').sort({ _id: 1 }).limit(4).lean();
    if (docs.length === 0) return rawAppellation;
    if (docs.every(d => d.name === docs[0].name)) return docs[0].name.slice(0, 200);
    return rawAppellation;
  } catch (err) {
    console.warn('[appellationResolve] lookup failed (non-fatal, keeping input):', err.message);
    return rawAppellation;
  }
}

module.exports = { resolveCanonicalAppellation };
