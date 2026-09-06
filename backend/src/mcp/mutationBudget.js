// Mutation budget for MCP tools — write-limiter parity at the tool layer (see
// the isMcp comment in app.js). Lives in its own module so BOTH mcp/server.js
// (which charges one slot per mutating tool call) and batch tools like bulk_add
// (which charge one slot PER ITEM upfront) can use it without a circular require.
//
// In-memory like express-rate-limit. Two dimensions (security audit L-18):
//   - per USER  — the write throughput of one account.
//   - per IP    — bounds the ~60×accounts amplification a per-user-only budget
//                 allowed (many accounts behind one NAT). Generous multiple of
//                 the per-user cap so a few colocated real users aren't throttled.
// All-or-nothing across BOTH dimensions and across a batch: a batch never
// half-charges before being refused, and a call that would breach either
// dimension takes nothing.
const WRITE_WINDOW_MS = 15 * 60 * 1000;
const userWindows = new Map(); // userId -> { start, count }
const ipWindows = new Map();   // ipKey  -> { start, count }
const WINDOWS_MAX = 5000;
// A single NAT/office may host several Cellarion users, each with their own AI
// connection; the per-IP write ceiling is a multiple of the per-user cap.
// Hosted connectors (claude.ai, ChatGPT) egress from a SMALL shared pool, so
// for them one "IP" is hundreds of users: at 4× four busy accounts blocked
// every other user on that egress from all MCP writes for the rest of the
// window (audit 2026-09 M02-2). 25× still bounds many-accounts-behind-one-
// address abuse (1,500 writes / 15 min is trivial load) without pooling
// strangers; the per-user cap is the real fairness layer.
const IP_WRITE_MULTIPLIER = 25;

// Evict the oldest half (insertion order) instead of clearing everyone (the old
// `.clear()` wiped every in-flight window when a burst of distinct keys hit the
// cap, resetting all limiters — security audit L-18).
function evictOldestHalf(map) {
  let drop = Math.ceil(WINDOWS_MAX / 2);
  for (const k of map.keys()) { if (drop-- <= 0) break; map.delete(k); }
}

// True if `n` more slots fit in key's current window without charging.
function hasRoom(map, key, n, max, now) {
  const w = map.get(key);
  if (!w || now - w.start >= WRITE_WINDOW_MS) return true; // fresh/expired window
  return w.count + n <= max;
}

// Charge `n` slots against key's window, rolling it over if fresh/expired.
function charge(map, key, n, now) {
  let w = map.get(key);
  if (!w || now - w.start >= WRITE_WINDOW_MS) {
    if (map.size >= WINDOWS_MAX) evictOldestHalf(map);
    w = { start: now, count: 0 };
    map.set(key, w);
  }
  w.count += n;
}

/**
 * Try to take `n` mutation slots for a user (and optionally their IP) in the
 * current 15-minute window. All-or-nothing: returns false (and takes NOTHING)
 * when fewer than n remain in EITHER dimension. `ipKey` is optional — omit it
 * (or pass null) for the per-user-only behaviour.
 */
function takeMutationSlot(userId, n = 1, ipKey = null) {
  const max = require('../config/rateLimits').get().write.max;
  const now = Date.now();
  if (n > max) return false; // a single batch larger than the whole window
  // Peek both dimensions first; commit only if both fit (single-threaded Node,
  // so peek-then-charge is atomic).
  if (!hasRoom(userWindows, userId, n, max, now)) return false;
  if (ipKey && !hasRoom(ipWindows, ipKey, n, max * IP_WRITE_MULTIPLIER, now)) return false;
  charge(userWindows, userId, n, now);
  if (ipKey) charge(ipWindows, ipKey, n, now);
  return true;
}

/**
 * Derive the per-IP budget key from an MCP request context, or null when no
 * request is attached (unit-test contexts) — in which case takeMutationSlot
 * falls back to the per-user-only budget. Lazy-requires clientIp to keep this
 * module off audit/MCP load paths.
 */
function ipKeyFor(ctx) {
  try {
    const { rateLimitKey } = require('../utils/clientIp');
    return (ctx && ctx.req) ? rateLimitKey(ctx.req) : null;
  } catch { return null; }
}

module.exports = { takeMutationSlot, ipKeyFor, WRITE_WINDOW_MS, IP_WRITE_MULTIPLIER };
