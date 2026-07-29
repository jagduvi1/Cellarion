/**
 * Wine matching / scoring service
 *
 * Consolidates the similarity scoring logic used by both the import pipeline
 * and the findOrCreateWine service into a single shared implementation.
 *
 * Composite score = name × 0.45 + producer × 0.45 + appellation × 0.10
 */

const { combinedSimilarity, normalizeString, normalizeProducerKey } = require('../utils/normalize');

const WEIGHTS = { name: 0.45, producer: 0.45, appellation: 0.10 };

// Label-abbreviation expansions applied to BOTH sides of the NAME comparison
// only — never to stored strings or keys. German labels print "GG" where the
// registry spells out "Großes Gewächs"; the prod-photo scan bench (2026-07-29)
// measured "Philippsbrunnen GG Riesling" vs "Riesling Philippsbrunnen Großes
// Gewächs" under the 0.75 match floor purely on this token, on every GG wine
// tested. Comparison-layer only, so no key or display string ever changes.
// normalizeString folds "Großes Gewächs" → 'groes gewachs' (ß deleted as
// punctuation-class, ä→a) — the expansion must target that exact folded form
// or it never matches the registry side.
const NAME_ABBREVIATIONS = [
  [/\bgg\b/g, 'groes gewachs'],
  [/\b1er\b/g, 'premier'],
];

function expandNameAbbreviations(normalized) {
  let out = normalized;
  for (const [re, full] of NAME_ABBREVIATIONS) out = out.replace(re, full);
  return out;
}

/** Name-axis similarity with abbreviation expansion on both sides. */
function nameSimilarity(a, b) {
  return combinedSimilarity(
    expandNameAbbreviations(normalizeString(a || '')),
    expandNameAbbreviations(normalizeString(b || ''))
  );
}

/**
 * Producer-axis similarity, compared on producer KEYS ("Kumeu River Wines
 * Limited" → "kumeu river") instead of raw strings. Corporate suffixes and
 * house prefixes used to drag the SAME winery to ~0.5 similarity, which put a
 * producer-variant duplicate at ~0.77 composite — under the soft zone, so it
 * was silently created (registry duplicate analysis 2026-07-22). On equal keys
 * the axis now scores 1. Falls back to the raw comparison whenever either side
 * has no key left (an all-stopword producer like "Domaine").
 */
function producerSimilarity(a, b) {
  const keyA = normalizeProducerKey(a || '');
  const keyB = normalizeProducerKey(b || '');
  return keyA && keyB ? combinedSimilarity(keyA, keyB) : combinedSimilarity(a, b);
}

/**
 * Score a single wine candidate against a query.
 *
 * @param {Object}  candidate       - WineDefinition (or plain object with .name, .producer, .appellation)
 * @param {Object}  query           - { name, producer, appellation } to match against
 * @param {Object}  [opts]
 * @param {boolean} [opts.redistribute=true] - When both sides lack an appellation, redistribute
 *                                             the appellation weight evenly to name & producer.
 * @returns {number} Composite score in [0, 1]
 */
function scoreWineMatch(candidate, query, { redistribute = true } = {}) {
  const nameScore     = nameSimilarity(candidate.name, query.name);
  const producerScore = producerSimilarity(candidate.producer, query.producer);

  let score = nameScore * WEIGHTS.name + producerScore * WEIGHTS.producer;

  const hasQueryApp     = Boolean(query.appellation);
  const hasCandidateApp = Boolean(candidate.appellation);

  if (hasQueryApp && hasCandidateApp) {
    score += combinedSimilarity(candidate.appellation, query.appellation) * WEIGHTS.appellation;
  } else if (hasQueryApp || hasCandidateApp) {
    // One side has appellation, other doesn't — slight penalty
    score += 0.5 * WEIGHTS.appellation;
  } else if (redistribute) {
    // Neither side has appellation — redistribute weight to name + producer
    score += (nameScore * 0.05 + producerScore * 0.05);
  } else {
    // Perfect match on absence — full weight
    score += 1.0 * WEIGHTS.appellation;
  }

  return score;
}

// ── Producer-embedded name variants (import path) ───────────────────────────
//
// The registry stores producer and wine name SEPARATELY, but import rows often
// embed the producer inside the wine name (CellarTracker's Bottles/Consumed
// tables have no Producer column — the Wine value is the full display name,
// e.g. "Domaine de la Romanée-Conti La Tâche"). Without variant handling those
// rows score poorly against their own registry wine, missing known wines.

/**
 * Normalized full display name: producer + name, deduped when the name
 * already embeds the producer as a prefix (same guard as generateWineSlug).
 * Makes producer placement irrelevant for equality comparison.
 */
function concatNormalized(producer, name) {
  const nName = normalizeString(name);
  const nProducer = normalizeString(producer);
  if (!nName) return nProducer;
  if (!nProducer || nName === nProducer || nName.startsWith(nProducer + ' ')) return nName;
  return `${nProducer} ${nName}`;
}

/**
 * If `name` starts with the tokens of `producer` (normalized comparison),
 * return the normalized remainder — else null. The remainder is safe to feed
 * back into the scorers/generateWineKey: normalizeString is idempotent.
 */
function stripProducerPrefix(name, producer) {
  const nName = normalizeString(name);
  const nProducer = normalizeString(producer);
  if (!nProducer || !nName.startsWith(nProducer + ' ')) return null;
  const remainder = nName.slice(nProducer.length + 1).trim();
  return remainder || null;
}

/**
 * Variant-aware scorer for the import path: the max of scoreWineMatch over
 * producer-embedded name variants. Strictly monotonic relative to
 * scoreWineMatch — the raw comparison is always included and max() only ever
 * raises the score — so it is safe to substitute wherever a higher score for
 * the same registry wine is desirable (import matching). Non-import callers
 * keep using scoreWineMatch unchanged.
 *
 * Variants:
 *   1. Raw (query.producer, query.name) — today's comparison.
 *   2. Concatenated equality: normalize(producer + ' ' + name) on both sides
 *      (deduped when the name embeds the producer) — equality is treated as
 *      an exact match (score 1).
 *   3. Query-producer strip: query.name starts with query.producer → also try
 *      the remainder as the name.
 *   4. Candidate-producer strip: query.name starts with the CANDIDATE's
 *      producer → try (candidate.producer, remainder); covers rows whose
 *      producer column is empty or a parser guess while the full display
 *      name is right.
 */
function scoreWineMatchVariants(candidate, query, opts) {
  let best = scoreWineMatch(candidate, query, opts);
  if (best >= 1) return best;

  // 2. Concatenated-normalized equality — producer placement irrelevant.
  // The concat signal deliberately ignores appellation, so two registry
  // siblings that share producer+name but differ only by appellation would
  // BOTH score a forced 1 and the arbitrary matches[0] would be auto-accepted
  // as exact. Only treat the concat match as a forced exact 1 when the
  // appellations AGREE (both absent, or the same normalized value); otherwise
  // fall through to the weighted scorer (appellation weighted 0.10 → ~0.90,
  // below the 0.95 exact threshold) so the disambiguation is forced. This
  // never LOWERS the raw score — `best` already holds it and the tail below
  // only ever raises it (monotonic).
  const queryFull = concatNormalized(query.producer, query.name);
  if (queryFull && queryFull === concatNormalized(candidate.producer, candidate.name)) {
    const qApp = normalizeString(query.appellation || '');
    const cApp = normalizeString(candidate.appellation || '');
    if (qApp === cApp) return 1;
  }

  // 3. Strip the query's own producer prefix off the query name.
  const strippedByQuery = stripProducerPrefix(query.name, query.producer);
  if (strippedByQuery) {
    best = Math.max(best, scoreWineMatch(candidate, { ...query, name: strippedByQuery }, opts));
  }

  // 4. Strip the candidate's producer prefix off the query name.
  const strippedByCandidate = stripProducerPrefix(query.name, candidate.producer);
  if (strippedByCandidate && strippedByCandidate !== strippedByQuery) {
    best = Math.max(
      best,
      scoreWineMatch(candidate, { ...query, name: strippedByCandidate, producer: candidate.producer }, opts)
    );
  }

  return best;
}

/**
 * Find the best match among a list of candidates.
 *
 * @param {Object}   query       - { name, producer, appellation }
 * @param {Object[]} candidates  - Array of WineDefinition objects
 * @param {Object}   [opts]      - Passed through to scoreWineMatch
 * @returns {{ bestMatch: Object|null, bestScore: number }}
 */
function findBestMatch(query, candidates, opts) {
  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreWineMatch(candidate, query, opts);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return { bestMatch, bestScore };
}

/**
 * Score every candidate and return them ranked by score (descending).
 * Used by the soft-zone "did you mean?" prompt: we want the top N near-matches
 * to show the user, not just the single best one.
 */
function scoreAllMatches(query, candidates, opts) {
  return candidates
    .map(c => ({ wine: c, score: scoreWineMatch(c, query, opts) }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  scoreWineMatch,
  scoreWineMatchVariants,
  concatNormalized,
  stripProducerPrefix,
  findBestMatch,
  scoreAllMatches,
  WEIGHTS,
};
