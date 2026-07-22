/**
 * Canonical wine identity — the durable duplicate-prevention key
 * (REGISTRY_DUPLICATE_ANALYSIS_2026-07-22, phase 1).
 *
 *   canonicalKey = normalizeProducerKey(producer)
 *                + ':' + normalizeString(canonicalizeWineName(name, producer))
 *                + ':' + normalizeString(normalizeAppellation(appellation))
 *
 * Unlike normalizedKey (raw strings, UNIQUE — deliberately untouched), the
 * canonical key collapses the three variance axes that mint duplicates:
 * producer spelling variants ("Felton Road Wines Ltd" ≡ "Felton Road"),
 * producer-in-name embeds ("Felton Road Block 3 Pinot Noir" ≡ "Block 3 Pinot
 * Noir"), and appellation tier suffixes ("Barolo DOCG" ≡ "Barolo").
 *
 * It is deliberately NON-unique: findOrCreateWine uses it as the first lookup
 * (a canonical duplicate can't be minted, because the lookup finds the
 * original), and the admin collision report drives cleanup of pre-existing
 * duplicates. Distinct wineries can legitimately collide (Domaine Chandon,
 * Napa vs Bodegas Chandon, Mendoza both key "chandon:garden spritz:…") —
 * which is exactly why collisions are a human-reviewed queue, not a unique
 * constraint, and why the matcher pairs canonical hits with the
 * different-country guard.
 */

const { normalizeString, normalizeProducerKey, normalizeAppellation } = require('./normalize');
const { canonicalizeWineName } = require('./producerPrefix');

// An all-stopword producer ("Domaine", "Cantina") has an EMPTY comparison key
// — falling back to the raw normalized string keeps such producers distinct
// from each other instead of sharing one canonical bucket. Mirrors the raw
// fallback in wineMatching.producerSimilarity.
const producerSegment = (producer) =>
  normalizeProducerKey(producer || '') || normalizeString(producer || '');

function computeCanonicalKey(name, producer, appellation = '') {
  const nameKey = normalizeString(canonicalizeWineName(name || '', producer || ''));
  const appellationKey = normalizeString(
    normalizeAppellation(typeof appellation === 'string' ? appellation : '') || ''
  );
  return `${producerSegment(producer)}:${nameKey}:${appellationKey}`;
}

/**
 * Prefix for canonical sibling lookups: same canonical producer + name, ANY
 * appellation. Anchored-regex scans on the canonicalKey index.
 */
function canonicalSiblingPrefix(name, producer) {
  const nameKey = normalizeString(canonicalizeWineName(name || '', producer || ''));
  return `${producerSegment(producer)}:${nameKey}:`;
}

module.exports = { computeCanonicalKey, canonicalSiblingPrefix };
