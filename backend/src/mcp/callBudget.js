// Cross-request MCP tool-call budget (security audit M-4 / prior audit M5).
//
// The per-request cap (MAX_CALLS_PER_REQUEST) and the per-IP HTTP limiters
// count REQUESTS, not tool calls — one request fans out to up to 20 calls
// (10 anonymous), and authenticated read tools otherwise have no cumulative
// budget at all, so a caller can drive thousands of full-portfolio / Qdrant
// reads per window (read amplification onto the 256 MB Qdrant shared with
// cellar chat). This is a rolling-window counter keyed by CALLER identity —
// the user id for authenticated connections, the client IP for the anonymous
// public surface — charged for every tool/resource/prompt call. Reads and
// writes both count (writes also ride the separate mutationBudget).
//
// In-memory like the mutation budget; a generous ceiling that only bites
// abuse, not legitimate agent turns.
const WINDOW_MS = 15 * 60 * 1000;

// Authenticated: ~2.2 calls/sec sustained for 15 min — far above any real
// agent session, far below the ~4,000 the request cap alone allowed.
const USER_CALL_MAX = 2000;
// Anonymous per-IP: the public request limiter is 60/15min × up to 10 calls =
// 600 possible; this tightens the actual work to 200 tool calls/15min/IP.
const PUBLIC_CALL_MAX = 200;

const windows = new Map(); // key -> { start, count }
const MAX_KEYS = 10000;

/**
 * Charge one call against the caller's rolling window. Returns true if the
 * call is within budget, false when the caller has exhausted it. Never throws.
 */
function takeCallSlot(key, max) {
  if (!max || max <= 0) return true; // 0/undefined = unlimited
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    if (windows.size >= MAX_KEYS) {
      // Evict the oldest half (insertion order) rather than clear everyone.
      let drop = Math.ceil(MAX_KEYS / 2);
      for (const k of windows.keys()) { if (drop-- <= 0) break; windows.delete(k); }
    }
    w = { start: now, count: 0 };
    windows.set(key, w);
  }
  w.count += 1;
  return w.count <= max;
}

/** The budget key + cap for a request context (anon → IP, else → user id). */
function budgetFor(ctx) {
  if (ctx.anonymous || !ctx.user) {
    let ip = 'anon';
    try { ip = require('../utils/clientIp').getClientIp(ctx.req) || 'anon'; } catch { /* no req in unit tests */ }
    return { key: `ip:${ip}`, max: PUBLIC_CALL_MAX };
  }
  return { key: `u:${ctx.user.id}`, max: USER_CALL_MAX };
}

/** True when the caller is still within their call budget (charges one slot). */
function withinCallBudget(ctx) {
  const { key, max } = budgetFor(ctx);
  return takeCallSlot(key, max);
}

module.exports = { takeCallSlot, withinCallBudget, budgetFor, WINDOW_MS, USER_CALL_MAX, PUBLIC_CALL_MAX };
