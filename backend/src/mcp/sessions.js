// Stateful MCP sessions (plan §4 — the proactive sommelier). The default
// /api/mcp mode stays stateless (fresh server per POST), but a client that
// echoes the Mcp-Session-Id from initialize gets a LIVE session: the same
// server instance across requests, a standalone GET/SSE stream, and
// resources/subscribe pushes wired to the event bus ("your 2015 Barolo just
// entered its window").
//
// Security model: a session id is a ROUTING key, never a credential. Every
// request through a session still passes requireAuth, and the session is
// bound at creation to the authenticated user (and the exact cel_ token when
// one was used) — a mismatching caller gets 404, indistinguishable from an
// expired session. Password change / logout / account deletion (eventBus
// dropUser) and token revocation (dropToken) destroy sessions immediately.
//
// Budgeted like /api/events/stream: per-user + global caps, sliding idle TTL,
// absolute lifetime. Single-process by design, like the event bus itself.
const crypto = require('crypto');
const eventBus = require('../services/eventBus');

const MAX_SESSIONS_PER_USER = 3;
const MAX_SESSIONS_GLOBAL = 200;
// Sliding idle TTL — refreshed by any request AND by every delivered push, so
// a quiet subscriber waiting for events isn't reaped mid-watch. 30 min idle
// with zero requests and zero pushes = the client is gone; it re-initializes
// on its next call (the SDK client handles a 404'd session transparently).
const IDLE_TTL_MS = 30 * 60 * 1000;
const ABSOLUTE_TTL_MS = 2 * 60 * 60 * 1000; // hard cap; also bounds stale-scope lifetime
const SWEEP_EVERY_MS = 60 * 1000;

const sessions = new Map(); // sessionId -> session
let perUserCounts = new Map(); // userIdString -> n
let sweepTimer = null;

function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (now - s.lastSeenAt > IDLE_TTL_MS || now - s.createdAt > ABSOLUTE_TTL_MS) {
        destroySession(s.id, 'expired');
      }
    }
    if (sessions.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_EVERY_MS);
  sweepTimer.unref?.(); // never hold the process (or jest) open
}

/**
 * Create a session shell (the caller attaches server/transport after the SDK
 * initialize handshake assigns the id). Returns null when a cap is hit —
 * callers fall back to stateless mode, which degrades subscriptions only.
 */
let lastGlobalCapWarn = 0;

function createSession({ userId, tokenId }) {
  const userKey = String(userId);
  if (sessions.size >= MAX_SESSIONS_GLOBAL) {
    // The cap silently degrades every other user to stateless mode (no
    // subscriptions) — make sure the operator can see it happening
    // (throttled, same convention as the event bus's stream cap).
    if (Date.now() - lastGlobalCapWarn > 60_000) {
      lastGlobalCapWarn = Date.now();
      console.warn(`[mcp] global session cap (${MAX_SESSIONS_GLOBAL}) reached — new MCP sessions fall back to stateless`);
    }
    return null;
  }
  // Per-user cap: EVICT the user's least-recently-seen session instead of
  // refusing. Refusing degraded the NEW connection to stateless — and Claude
  // Desktop treats a session-less initialize as a broken server: it bailed
  // out and revoked its fresh grant (launch-day report: connecting a 4th
  // client silently failed while old claude.ai sessions kept the 3 slots
  // alive via SSE refreshes). The newest connection is the one the user is
  // actually at; their stalest one dies, exactly like the event bus treats
  // its stream cap. Global cap stays a refusal — evicting ANOTHER user's
  // live session to seat this one would trade a known cost for a stranger's.
  if ((perUserCounts.get(userKey) || 0) >= MAX_SESSIONS_PER_USER) {
    let oldest = null;
    for (const s of sessions.values()) {
      if (s.userId === userKey && (!oldest || s.lastSeenAt < oldest.lastSeenAt)) oldest = s;
    }
    if (oldest) {
      destroySession(oldest.id, 'evicted_for_new_session');
    }
    if ((perUserCounts.get(userKey) || 0) >= MAX_SESSIONS_PER_USER) return null; // defensive: eviction failed
  }

  const session = {
    id: crypto.randomUUID(),
    userId: userKey,
    tokenId: tokenId ? String(tokenId) : null,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    server: null,        // set by routes/mcp.js after buildServer
    transport: null,     // set by routes/mcp.js
    callState: { calls: 0 }, // reset per request (per-request call budget)
    subscriptions: new Set(), // subscribed resource URIs
    busUnsub: null,      // eventBus listener teardown
  };
  sessions.set(session.id, session);
  perUserCounts.set(userKey, (perUserCounts.get(userKey) || 0) + 1);
  ensureSweeper();
  return session;
}

/**
 * Look up a session for a request. Binds routing to identity: the session
 * must belong to the SAME authenticated user AND the same credential kind
 * (a cel_ token session cannot be continued by a JWT and vice versa; a
 * different token of the same user cannot hijack it either). Mismatch or
 * missing → null; callers answer 404 either way (no oracle).
 */
function getSession(sessionId, { userId, tokenId }) {
  const s = sessions.get(String(sessionId || ''));
  if (!s) return null;
  if (s.userId !== String(userId)) return null;
  if ((s.tokenId || null) !== (tokenId ? String(tokenId) : null)) return null;
  const now = Date.now();
  if (now - s.lastSeenAt > IDLE_TTL_MS || now - s.createdAt > ABSOLUTE_TTL_MS) {
    destroySession(s.id, 'expired');
    return null;
  }
  s.lastSeenAt = now;
  return s;
}

function destroySession(sessionId, reason = 'closed') {
  const s = sessions.get(String(sessionId));
  if (!s) return false;
  sessions.delete(s.id);
  const left = (perUserCounts.get(s.userId) || 1) - 1;
  if (left <= 0) perUserCounts.delete(s.userId);
  else perUserCounts.set(s.userId, left);
  try { s.busUnsub?.(); } catch { /* already gone */ }
  // Close transport+server asynchronously; a rejected close must never crash
  // the hot path (same rationale as the stateless per-request teardown).
  Promise.resolve().then(() => s.transport?.close()).catch(() => {});
  Promise.resolve().then(() => s.server?.close()).catch(() => {});
  return true;
}

function dropUserSessions(userId) {
  const key = String(userId);
  for (const s of [...sessions.values()]) {
    if (s.userId === key) destroySession(s.id, 'user_dropped');
  }
}

function dropTokenSessions(tokenId) {
  const id = String(tokenId);
  for (const s of [...sessions.values()]) {
    if (s.tokenId === id) destroySession(s.id, 'token_revoked');
  }
}

// Sessions die wherever SSE streams die (password change, logout, deletion,
// token revoke) — registered once at module load.
eventBus.onDropUser(dropUserSessions);
eventBus.onDropToken(dropTokenSessions);

/** Counts for tests/ops. */
function sessionCounts() {
  return { total: sessions.size, users: perUserCounts.size };
}

module.exports = {
  createSession, getSession, destroySession, sessionCounts,
  dropUserSessions, dropTokenSessions,
  MAX_SESSIONS_PER_USER, MAX_SESSIONS_GLOBAL, IDLE_TTL_MS, ABSOLUTE_TTL_MS,
};
