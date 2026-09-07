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

// ── Appellation-first names and bracketed producers (import path) ───────────
//
// CellarTracker composes its "Wine" display name as producer + appellation +
// designation ("Bodegas Muga Rioja Prado Enea Gran Reserva"), so after the
// producer prefix is stripped the row still LEADS with the appellation
// ("Rioja Prado Enea Gran Reserva") while the registry stores the designation
// alone ("Prado Enea Gran Reserva"). Producers arrive with a parenthetical
// the registry does not carry ("Ca' Marcanda (Gaja)"). A re-import of one
// such file re-created its entire request queue (44 rows, 2026-09-06) —
// every wine already existed. Both are comparison-layer variants: stored
// strings and keys never change.

// Legal-tier suffixes that ride on an appellation hint ("Chianti Classico
// DOCG", "Rioja DOCa") but never on the wine name's leading words.
const APPELLATION_TIER_RX = /\b(docg|doca|doc|dop|aoc|aop|igt|igp|ava|gi|do|vdp|vdqs)\b/g;
// A remainder made only of these is a style or a grape, not a name ("Rioja
// Reserva" → "Reserva", "Wehlener Sonnenuhr Riesling Auslese" → "Riesling
// Auslese" where the "appellation" is the single vineyard the registry keeps
// in the name): stripping would make every such wine of the appellation
// collide, so the name is left whole.
const GENERIC_WORDS = new Set([
  'reserva', 'gran', 'grande', 'riserva', 'reserve', 'crianza', 'joven', 'classico', 'superiore',
  'brut', 'extra', 'sec', 'demi', 'dry', 'trocken', 'feinherb', 'halbtrocken', 'kabinett', 'spatlese',
  'auslese', 'beerenauslese', 'trockenbeerenauslese', 'eiswein', 'gg', 'groes', 'gewachs', 'erstes',
  'rouge', 'blanc', 'rose', 'rosado', 'bianco', 'rosso', 'tinto', 'branco', 'red', 'white', 'sekt',
  'riesling', 'chardonnay', 'pinot', 'noir', 'gris', 'grigio', 'blanco', 'sauvignon', 'merlot', 'cabernet',
  'franc', 'syrah', 'shiraz', 'grenache', 'garnacha', 'tempranillo', 'sangiovese', 'nebbiolo', 'barbera',
  'dolcetto', 'malbec', 'zinfandel', 'gewurztraminer', 'gruner', 'veltliner', 'chenin', 'viognier', 'muscat',
  'moscato', 'mourvedre', 'carignan', 'gamay', 'mencia', 'garganega', 'albarino', 'alvarinho', 'verdejo',
  'godello', 'touriga', 'nacional', 'franca', 'spatburgunder', 'weissburgunder', 'grauburgunder', 'silvaner',
  'sylvaner', 'muller', 'thurgau', 'blaufrankisch', 'zweigelt', 'semillon', 'primitivo', 'aglianico',
  'montepulciano', 'corvina', 'glera', 'trebbiano', 'vermentino', 'verdicchio', 'fiano', 'greco', 'nero',
  'davola', 'carmenere', 'petit', 'verdot', 'roussanne', 'marsanne', 'cinsault', 'furmint', 'assyrtiko',
]);
const isGenericRemainder = (normalized) => normalized.split(' ').filter(Boolean).every((t) => GENERIC_WORDS.has(t));

function normalizedAppellationHead(hint) {
  return normalizeString(hint || '').replace(APPELLATION_TIER_RX, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * If `name` starts with the appellation (or region) hint, return the
 * normalized remainder — else null. Null too when the remainder is a bare
 * style word, or when the hint would swallow the whole name.
 */
function stripAppellationPrefix(name, hint) {
  const nName = normalizeString(name || '');
  const head = normalizedAppellationHead(hint);
  if (!head || !nName.startsWith(head + ' ')) return null;
  const remainder = nName.slice(head.length + 1).trim();
  if (!remainder || isGenericRemainder(remainder)) return null;
  return remainder;
}

/** Normalized name with a trailing parenthetical removed ("Château Lagrange (St. Julien)"); null when nothing to strip. */
function stripNameBrackets(name) {
  const bare = stripProducerBrackets(name);
  return bare ? normalizeString(bare) : null;
}

/** "Ca' Marcanda (Gaja)" → "Ca' Marcanda"; null when nothing to strip or nothing left. */
function stripProducerBrackets(producer) {
  const raw = String(producer || '').trim();
  const stripped = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return stripped && stripped !== raw ? stripped : null;
}

/**
 * The query strings an import row should try against the search engine, in
 * order: the raw producer + name, then the same with the appellation prefix
 * and the producer's parenthetical removed. Distinct, non-empty.
 */
function importQueryVariants(item) {
  const out = [];
  const push = (producer, name) => { const q = `${producer || ''} ${name || ''}`.trim(); if (q && !out.includes(q)) out.push(q); };
  push(item.producer, item.wineName);
  const producer = stripProducerBrackets(item.producer) || item.producer;
  const name = stripAppellationPrefix(item.wineName, item.appellation) || stripAppellationPrefix(item.wineName, item.region) || item.wineName;
  push(producer, name);
  return out;
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
  if (best >= 1) return best;

  // 5–7. Appellation-first names and bracketed producers (see the note
  // above): every combination of {name, appellation-stripped name} ×
  // {producer, bracket-stripped producer}, on BOTH sides, still max()-ed over
  // the raw comparison so the result never drops below scoreWineMatch.
  const nameVariants = [query.name];
  for (const hint of [query.appellation, query.region, candidate.appellation]) {
    const v = stripAppellationPrefix(query.name, hint);
    if (v && !nameVariants.includes(v)) nameVariants.push(v);
  }
  const bareName = stripNameBrackets(query.name);
  if (bareName && !nameVariants.includes(bareName)) nameVariants.push(bareName);
  const producerVariants = [query.producer];
  const qBare = stripProducerBrackets(query.producer);
  if (qBare) producerVariants.push(qBare);
  const candidateVariants = [candidate];
  const cBare = stripProducerBrackets(candidate.producer);
  if (cBare) candidateVariants.push({ ...candidate, producer: cBare });
  for (const cand of candidateVariants) {
    for (const producer of producerVariants) {
      for (const name of nameVariants) {
        if (cand === candidate && producer === query.producer && name === query.name) continue; // the raw pair, already in `best`
        best = Math.max(best, scoreWineMatch(cand, { ...query, name, producer }, opts));
        if (best >= 1) return best;
      }
    }
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
  stripAppellationPrefix,
  stripProducerBrackets,
  importQueryVariants,
  findBestMatch,
  scoreAllMatches,
  WEIGHTS,
};
