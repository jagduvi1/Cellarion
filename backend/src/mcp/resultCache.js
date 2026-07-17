// Tiny per-user TTL result cache shared by the portfolio-scale read tools
// (insights, drinking, journey — same idea as the cellar_stats cache).
// Automated callers repeat identical questions; these tools load the caller's
// whole bottle set per call, so without a cache MAX_CALLS_PER_REQUEST × the
// request limiter allows a hostile-but-authenticated token to drive thousands
// of full-portfolio populated loads per window (read amplification). A 60s
// stale window is irrelevant for portfolio-level answers.
const cache = new Map(); // key -> { at, result }
const TTL_MS = 60 * 1000;
const CACHE_MAX = 2000;

/**
 * Serve `${tool}:${userId}:${variant}` from cache or compute it. `variant`
 * must encode every argument that changes the result (stringified args).
 */
async function cachedResult(tool, userId, variant, compute) {
  const key = `${tool}:${userId}:${variant}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
  const result = await compute();
  if (cache.size >= CACHE_MAX) {
    // Evict the oldest half (Map preserves insertion order) instead of a
    // wholesale clear — one user's churn shouldn't cold-start everyone.
    let drop = Math.ceil(CACHE_MAX / 2);
    for (const k of cache.keys()) { if (drop-- <= 0) break; cache.delete(k); }
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

/**
 * Drop every cached entry for one user — called when their cellar mutates
 * (grand-audit M3), so the next read recomputes instead of serving a stale
 * 60s window (e.g. a just-consumed bottle still ranked as a "tonight"
 * candidate). Keys are `${tool}:${userId}:${variant}`.
 */
function bustUser(userId) {
  const needle = `:${userId}:`;
  for (const k of cache.keys()) {
    if (k.includes(needle)) cache.delete(k);
  }
}

module.exports = { cachedResult, bustUser, TTL_MS };
