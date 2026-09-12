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
// Unrouted sessions whose transport is kept open for a request still being
// served on it (see destroySession). Revocation and the sweeper scan this
// too — a draining session must never outlive its credential, or a hung
// handler (post-ship audit 2026-09-12, M1).
const draining = new Map(); // sessionId -> session
let perUserCounts = new Map(); // userIdString -> n
let sweepTimer = null;
// A drain older than this is force-closed: no legitimate tool call runs
// for minutes, so the request is hung and the transport would leak.
const DRAIN_MAX_MS = 5 * 60 * 1000;

function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (now - s.lastSeenAt > IDLE_TTL_MS || now - s.createdAt > ABSOLUTE_TTL_MS) {
        destroySession(s.id, 'expired');
      }
    }
    for (const s of [...draining.values()]) {
      if (now - s.drainingSince > DRAIN_MAX_MS) closeSessionIo(s, `${s.pendingDestroy}_drain_timeout`);
    }
    if (sessions.size === 0 && draining.size === 0 && sweepTimer) {
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
    // Prefer a session with nothing in flight; among those, the stalest.
    let oldest = null;
    for (const s of sessions.values()) {
      if (s.userId !== userKey) continue;
      const busy = (s.inFlight || 0) > 0;
      const oldestBusy = oldest ? (oldest.inFlight || 0) > 0 : true;
      if (!oldest || (oldestBusy && !busy) || (busy === oldestBusy && s.lastSeenAt < oldest.lastSeenAt)) oldest = s;
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
    inFlight: 0,         // requests currently being served (beginRequest/endRequest)
    pendingDestroy: null, // reason of a destroy deferred until inFlight reaches 0
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

// Reasons that must tear the transport down NOW even with a request in
// flight: the credential is gone (security), the client asked, or the
// transport already died. Everything else (expiry, cap eviction) waits for
// the in-flight request to finish.
const IMMEDIATE_REASONS = new Set(['user_dropped', 'token_revoked', 'client_delete', 'init_failed', 'transport_closed']);

/**
 * A request is being served on this session. Housekeeping (cap eviction,
 * TTL sweep) must not close the transport under it: a client whose
 * response stream dies mid-call is told "session expired" for a write the
 * server has already committed (support ticket 2026-09-12 — a support
 * ticket filed twice would have been the result). Call endRequest in a
 * finally.
 */
function beginRequest(session) {
  if (!session) return;
  session.inFlight = (session.inFlight || 0) + 1;
}

function endRequest(session) {
  if (!session) return;
  session.inFlight = Math.max(0, (session.inFlight || 1) - 1);
  if (session.inFlight === 0 && session.pendingDestroy) closeSessionIo(session, session.pendingDestroy);
}

function closeSessionIo(s, reason) {
  s.pendingDestroy = null;
  draining.delete(s.id);
  try { s.busUnsub?.(); } catch { /* already gone */ }
  // Close transport+server asynchronously; a rejected close must never crash
  // the hot path (same rationale as the stateless per-request teardown).
  Promise.resolve().then(() => s.transport?.close()).catch(() => {});
  Promise.resolve().then(() => s.server?.close()).catch(() => {});
  console.log(`[mcp] session ${s.id.slice(0, 8)} closed (${reason})`);
}

function destroySession(sessionId, reason = 'closed') {
  const s = sessions.get(String(sessionId));
  if (!s) return false;
  // Unrouted at once: the slot is free and a new request gets 404 → the
  // client re-initializes cleanly. The transport itself only closes once no
  // request is being served on it (unless the reason says otherwise).
  sessions.delete(s.id);
  const left = (perUserCounts.get(s.userId) || 1) - 1;
  if (left <= 0) perUserCounts.delete(s.userId);
  else perUserCounts.set(s.userId, left);
  if ((s.inFlight || 0) > 0 && !IMMEDIATE_REASONS.has(reason)) {
    s.pendingDestroy = reason;
    s.drainingSince = Date.now();
    draining.set(s.id, s);
    ensureSweeper(); // bounds the drain even when the routed map is empty
    console.log(`[mcp] session ${s.id.slice(0, 8)} unrouted (${reason}) — ${s.inFlight} request(s) in flight, transport kept until they finish`);
    return true;
  }
  closeSessionIo(s, reason);
  return true;
}

// Credential gone: every session of that user/token closes NOW — routed or
// draining. A draining transport must not keep serving a revoked credential.
function dropUserSessions(userId) {
  const key = String(userId);
  for (const s of [...sessions.values()]) {
    if (s.userId === key) destroySession(s.id, 'user_dropped');
  }
  for (const s of [...draining.values()]) {
    if (s.userId === key) closeSessionIo(s, 'user_dropped');
  }
}

function dropTokenSessions(tokenId) {
  const id = String(tokenId);
  for (const s of [...sessions.values()]) {
    if (s.tokenId === id) destroySession(s.id, 'token_revoked');
  }
  for (const s of [...draining.values()]) {
    if (s.tokenId === id) closeSessionIo(s, 'token_revoked');
  }
}

// Sessions die wherever SSE streams die (password change, logout, deletion,
// token revoke) — registered once at module load.
eventBus.onDropUser(dropUserSessions);
eventBus.onDropToken(dropTokenSessions);

/** Counts for tests/ops. */
function sessionCounts() {
  return { total: sessions.size, users: perUserCounts.size, draining: draining.size };
}

module.exports = {
  createSession, getSession, destroySession, sessionCounts,
  beginRequest, endRequest,
  dropUserSessions, dropTokenSessions,
  MAX_SESSIONS_PER_USER, MAX_SESSIONS_GLOBAL, IDLE_TTL_MS, ABSOLUTE_TTL_MS, DRAIN_MAX_MS,
};
