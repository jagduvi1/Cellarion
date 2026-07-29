/**
 * Canonical producer SPELLING at mint time (registry strategy 2026-07-29, R1).
 *
 * The producer is a free string, and every dedup mechanism in the registry —
 * normalizedKey, canonicalKey, duplicate clusters, sibling matching — is
 * derived from it. The keys themselves are spelling-proof (normalizeString
 * folds accents/case/punctuation), which is exactly why display splits slip
 * through every net: "Cave de Ribeauvillé" (12 wines) and a hand-typed "Cave
 * de Ribeauville" (1 wine) never collide on any KEY, so nothing ever flagged
 * them, and the registry showed two producers where the world has one
 * (support ticket 2026-07-28, finding 2).
 *
 * The fix is at the source: when a NEW wine is about to be minted, look up
 * every existing wine of the same normalized producer (anchored prefix scan on
 * the indexed normalizedKey — 'producer:name:appellation', and ':' can never
 * appear inside the producer segment because normalizeString strips
 * punctuation) and adopt the majority raw spelling. The user who types the
 * accent-less variant gets the registry's canonical one; no new split is ever
 * created. Display-only by construction: every derived key normalizes both
 * spellings identically, so adopting changes NOTHING but the string users see.
 *
 * Majority = most wines, ties broken by the spelling whose earliest wine is
 * oldest (stability: the registry's original spelling wins a 1-vs-1).
 *
 * Mint-time only, like the producer-is-a-place gate: existing rows are
 * unified once by scripts/unify-producer-spellings.js and stay consistent
 * from then on because this function prevents new divergence.
 */
const WineDefinition = require('../models/WineDefinition');
const { escapeRegex } = require('../utils/sanitize');

/**
 * @param {string} rawProducer   trimmed display producer the caller wants to store
 * @param {string} producerNorm  normalizeString(rawProducer) — caller already has it
 * @returns {Promise<string>} the spelling to store (majority, or the input when
 *   this producer is new to the registry). Never throws — on lookup failure the
 *   input spelling is kept; a mint must not fail over a display nicety.
 */
async function resolveCanonicalProducerSpelling(rawProducer, producerNorm) {
  if (!producerNorm) return rawProducer;
  try {
    const rows = await WineDefinition.aggregate([
      // Quarantined rows keep their spelling but don't get a vote — a nonWine
      // row's producer is exactly the kind of data we don't want to copy.
      { $match: { normalizedKey: new RegExp(`^${escapeRegex(producerNorm)}:`), nonWine: { $ne: true } } },
      { $group: { _id: '$producer', count: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
      { $sort: { count: -1, oldest: 1 } },
      { $limit: 1 },
    ]);
    return rows[0]?._id || rawProducer;
  } catch (err) {
    console.warn('[producerSpelling] lookup failed (non-fatal, keeping input):', err.message);
    return rawProducer;
  }
}

module.exports = { resolveCanonicalProducerSpelling };
