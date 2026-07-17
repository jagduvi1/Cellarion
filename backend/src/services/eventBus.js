/**
 * In-memory SSE event bus (docs/ha-push-events.md §1).
 *
 * Holds the open /api/events/stream responses per user and fans out
 * "something changed" nudges. Events carry NO cellar data — clients react to
 * any event by refreshing via the normal REST API — so the bus can stay dumb:
 * per-user debounce, last event wins.
 *
 * Single-process by design (the backend runs as one Node process). If the
 * deployment ever goes multi-instance this becomes a thin facade over Redis
 * pub/sub; the route and emitters stay the same.
 *
 * Hardening beyond the spec sketch:
 * - writes are guarded (a half-dead socket must never throw into an emitter)
 * - debounce timers are cleaned up when they fire or when the user drops
 * - a GLOBAL stream cap protects the whole process, not just one user
 * - dropToken() closes only the streams a revoked API token authenticated
 */

const MAX_STREAMS_PER_USER = 5;
const MAX_STREAMS_GLOBAL = 500;
const DEBOUNCE_MS = 2000;

// userId -> Set<{ res, tokenId }>
const streams = new Map();
// userId -> pending debounce timer
const timers = new Map();
let totalStreams = 0;

// userId -> Set<fn(event, data)> — in-process listeners (MCP session
// subscriptions, plan §4). They ride the same per-user debounce as the SSE
// streams; a listener that throws is dropped from that delivery only.
const listeners = new Map();
// Hooks invoked by dropUser/dropToken so OTHER session stores (MCP stateful
// sessions) are torn down wherever SSE streams are — password change, token
// revoke, account deletion — without those routes needing to know about them.
const dropUserHooks = [];
const dropTokenHooks = [];

function safeWrite(res, frame) {
  if (res.destroyed || res.writableEnded) return;
  try { res.write(frame); } catch { /* socket died mid-write — close handler cleans up */ }
}

function safeEnd(res) {
  if (res.destroyed || res.writableEnded) return;
  try { res.end(); } catch { /* already gone */ }
}

/**
 * Queue an event for all of a user's open streams, debounced per user so a
 * 50-bottle import produces one nudge, not 50. Within the window the LAST
 * event wins — clients refresh everything on any event, so coalescing loses
 * nothing.
 */
function emit(userId, event, data = {}) {
  const key = String(userId);
  const set = streams.get(key);
  const fns = listeners.get(key);
  if ((!set || set.size === 0) && (!fns || fns.size === 0)) return;

  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    timers.delete(key);
    const current = streams.get(key);
    if (current) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const entry of current) safeWrite(entry.res, frame);
    }
    const currentFns = listeners.get(key);
    if (currentFns) {
      for (const fn of currentFns) {
        try { fn(event, data); } catch { /* one bad listener must not break the fan-out */ }
      }
    }
  }, DEBOUNCE_MS);
  // Never hold the process open just for a pending nudge (also keeps Jest quiet)
  timer.unref?.();
  timers.set(key, timer);
}

/**
 * Register an in-process listener for one user's events (same debounce as the
 * SSE streams; within a window the LAST event wins). Returns an unsubscribe
 * function. Listener counts are NOT capped here — callers (MCP sessions) have
 * their own session caps.
 */
function addListener(userId, fn) {
  const key = String(userId);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    const cur = listeners.get(key);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(key);
  };
}

/** Register a hook invoked with (userId) whenever dropUser tears a user down. */
function onDropUser(hook) { dropUserHooks.push(hook); }
/** Register a hook invoked with (tokenId) whenever dropToken fires. */
function onDropToken(hook) { dropTokenHooks.push(hook); }

/**
 * Register an open SSE response. tokenId is set when the stream was
 * authenticated by a personal API token, so dropToken() can find it.
 * Returns { ok: true } or { ok: false, reason: 'user_cap' | 'global_cap' }.
 */
let lastGlobalCapWarn = 0;

function register(userId, res, tokenId = null) {
  if (totalStreams >= MAX_STREAMS_GLOBAL) {
    // The cap silently degrades every OTHER user to polling — make sure the
    // operator can see it happening (throttled so reconnect storms don't spam).
    if (Date.now() - lastGlobalCapWarn > 60_000) {
      lastGlobalCapWarn = Date.now();
      console.warn(`[eventBus] global stream cap (${MAX_STREAMS_GLOBAL}) reached — new SSE connections are being rejected`);
    }
    return { ok: false, reason: 'global_cap' };
  }
  const key = String(userId);
  let set = streams.get(key);
  if (!set) {
    set = new Set();
    streams.set(key, set);
  }
  if (set.size >= MAX_STREAMS_PER_USER) return { ok: false, reason: 'user_cap' };
  set.add({ res, tokenId: tokenId ? String(tokenId) : null });
  totalStreams++;
  return { ok: true };
}

/** Remove a response (client disconnected or stream aged out). */
function unregister(userId, res) {
  const key = String(userId);
  const set = streams.get(key);
  if (!set) return;
  for (const entry of set) {
    if (entry.res === res) {
      set.delete(entry);
      totalStreams--;
      break;
    }
  }
  if (set.size === 0) {
    streams.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
  }
}

/**
 * Force-close ALL of a user's streams. Call wherever refresh sessions are
 * invalidated: password change, password reset, logout, account deletion.
 * (ended sockets fire 'close', whose handler unregisters them — but do the
 * bookkeeping here too so caps free up immediately, not a tick later.)
 */
function dropUser(userId) {
  const key = String(userId);
  for (const hook of dropUserHooks) {
    try { hook(key); } catch { /* a failing hook must not block session teardown */ }
  }
  const set = streams.get(key);
  if (!set) return;
  for (const entry of set) {
    safeEnd(entry.res);
    totalStreams--;
  }
  streams.delete(key);
  clearTimeout(timers.get(key));
  timers.delete(key);
}

/** Force-close the streams a specific (revoked) API token authenticated. */
function dropToken(tokenId) {
  const id = String(tokenId);
  for (const hook of dropTokenHooks) {
    try { hook(id); } catch { /* a failing hook must not block stream teardown */ }
  }
  for (const [key, set] of streams) {
    for (const entry of set) {
      if (entry.tokenId === id) {
        safeEnd(entry.res);
        set.delete(entry);
        totalStreams--;
      }
    }
    if (set.size === 0) {
      streams.delete(key);
      clearTimeout(timers.get(key));
      timers.delete(key);
    }
  }
}

/** Counts for logging/tests. */
function streamCounts() {
  return { total: totalStreams, users: streams.size };
}

module.exports = {
  emit,
  register,
  unregister,
  addListener,
  onDropUser,
  onDropToken,
  dropUser,
  dropToken,
  streamCounts,
  MAX_STREAMS_PER_USER,
  MAX_STREAMS_GLOBAL,
  DEBOUNCE_MS,
};
