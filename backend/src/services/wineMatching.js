/**
 * Wine matching / scoring service
 *
 * Consolidates the similarity scoring logic used by both the import pipeline
 * and the findOrCreateWine service into a single shared implementation.
 *
 * Composite score = name × 0.45 + producer × 0.45 + appellation × 0.10
 */

const { combinedSimilarity } = require('../utils/normalize');

const WEIGHTS = { name: 0.45, producer: 0.45, appellation: 0.10 };

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
  const nameScore     = combinedSimilarity(candidate.name, query.name);
  const producerScore = combinedSimilarity(candidate.producer, query.producer);

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

module.exports = { scoreWineMatch, findBestMatch, WEIGHTS };
