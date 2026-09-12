/**
 * MCP stateful sessions (plan §4) — store invariants.
 *
 * A session id is a ROUTING key, never a credential: these tests pin the
 * identity binding (user AND credential kind), both caps, idle/absolute
 * expiry, idempotent destroy, and that credential-revocation events
 * (eventBus dropUser/dropToken) tear sessions down.
 */

let sessions;
let eventBus;

beforeEach(() => {
  jest.resetModules(); // fresh singleton state (store + bus) per test
  jest.useFakeTimers();
  eventBus = require('../services/eventBus');
  sessions = require('./sessions');
});
afterEach(() => jest.useRealTimers());

const mkTransport = () => ({ close: jest.fn().mockResolvedValue() });

describe('identity binding', () => {
  test('a session resolves only for the SAME user and the SAME credential kind', () => {
    const s = sessions.createSession({ userId: 'u1', tokenId: 'tok1' });
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: 'tok1' })).toBe(s);
    // wrong user
    expect(sessions.getSession(s.id, { userId: 'u2', tokenId: 'tok1' })).toBeNull();
    // right user, different token
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: 'tok2' })).toBeNull();
    // right user, JWT instead of the token
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: null })).toBeNull();
  });

  test('a JWT session cannot be continued by a token of the same user', () => {
    const s = sessions.createSession({ userId: 'u1', tokenId: null });
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: null })).toBe(s);
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: 'tok1' })).toBeNull();
  });

  test('unknown ids and junk resolve to null (no oracle, no crash)', () => {
    expect(sessions.getSession('nope', { userId: 'u1', tokenId: null })).toBeNull();
    expect(sessions.getSession(undefined, { userId: 'u1', tokenId: null })).toBeNull();
  });
});

describe('caps', () => {
  test('per-user cap EVICTS the least-recently-seen session — the new client always seats', () => {
    // The launch-day Desktop report: refusing the 4th session degraded the NEW
    // connection to stateless, which Claude Desktop treats as a broken server.
    const a = sessions.createSession({ userId: 'u1' });
    jest.advanceTimersByTime(1000);
    const b = sessions.createSession({ userId: 'u1' });
    jest.advanceTimersByTime(1000);
    const c = sessions.createSession({ userId: 'u1' });
    jest.advanceTimersByTime(1000);
    jest.setSystemTime(Date.now());
    // b becomes most-recently-seen; a stays the stalest.
    expect(sessions.getSession(b.id, { userId: 'u1', tokenId: null })).toBe(b);

    const d = sessions.createSession({ userId: 'u1' });
    expect(d).not.toBeNull(); // seated, not refused
    expect(sessions.getSession(a.id, { userId: 'u1', tokenId: null })).toBeNull(); // stalest evicted
    expect(sessions.getSession(b.id, { userId: 'u1', tokenId: null })).toBe(b);    // survivors intact
    expect(sessions.getSession(c.id, { userId: 'u1', tokenId: null })).toBe(c);
    expect(sessions.createSession({ userId: 'u2' })).not.toBeNull(); // other users unaffected
  });

  test('destroy frees a slot without waiting for eviction', () => {
    const a = sessions.createSession({ userId: 'u1' });
    sessions.createSession({ userId: 'u1' });
    sessions.createSession({ userId: 'u1' });
    sessions.destroySession(a.id);
    const d = sessions.createSession({ userId: 'u1' });
    expect(d).not.toBeNull();
  });

  test('global cap refuses new sessions across all users', () => {
    for (let i = 0; i < sessions.MAX_SESSIONS_GLOBAL; i++) {
      // spread across users so the per-user cap never trips first
      expect(sessions.createSession({ userId: `u${Math.floor(i / 2)}` })).not.toBeNull();
    }
    expect(sessions.createSession({ userId: 'fresh' })).toBeNull();
  });
});

describe('expiry', () => {
  test('idle TTL: a quiet session expires on next lookup; activity refreshes it', () => {
    const s = sessions.createSession({ userId: 'u1' });
    jest.advanceTimersByTime(sessions.IDLE_TTL_MS - 1000);
    jest.setSystemTime(Date.now()); // fake timers drive Date.now via modern mode
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: null })).toBe(s); // refreshed
    jest.advanceTimersByTime(sessions.IDLE_TTL_MS + 1000);
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: null })).toBeNull();
    expect(sessions.sessionCounts().total).toBe(0);
  });

  test('absolute TTL bounds even an active session', () => {
    const s = sessions.createSession({ userId: 'u1' });
    // keep touching it every 10 min, well inside the idle TTL
    const steps = Math.ceil(sessions.ABSOLUTE_TTL_MS / (10 * 60 * 1000)) + 1;
    for (let i = 0; i < steps - 1; i++) {
      jest.advanceTimersByTime(10 * 60 * 1000);
      sessions.getSession(s.id, { userId: 'u1', tokenId: null });
    }
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: null })).toBeNull();
  });

  test('the sweeper reaps idle sessions in the background and stops when empty', () => {
    const s = sessions.createSession({ userId: 'u1' });
    s.transport = mkTransport();
    jest.advanceTimersByTime(sessions.IDLE_TTL_MS + 61 * 1000); // TTL + one sweep
    expect(sessions.sessionCounts().total).toBe(0);
  });
});

describe('teardown', () => {
  test('destroy closes transport+server, runs the bus unsubscribe, and is idempotent', () => {
    const s = sessions.createSession({ userId: 'u1' });
    const unsub = jest.fn();
    s.transport = mkTransport();
    s.server = { close: jest.fn().mockResolvedValue() };
    s.busUnsub = unsub;
    expect(sessions.destroySession(s.id)).toBe(true);
    expect(unsub).toHaveBeenCalled();
    expect(sessions.destroySession(s.id)).toBe(false); // second call: gone
    expect(sessions.sessionCounts().total).toBe(0);
  });

  test('eventBus.dropUser tears down that user\'s sessions only', () => {
    const mine = sessions.createSession({ userId: 'u1' });
    const other = sessions.createSession({ userId: 'u2' });
    eventBus.dropUser('u1');
    expect(sessions.getSession(mine.id, { userId: 'u1', tokenId: null })).toBeNull();
    expect(sessions.getSession(other.id, { userId: 'u2', tokenId: null })).toBe(other);
  });

  test('eventBus.dropToken tears down exactly the revoked token\'s sessions', () => {
    const tok = sessions.createSession({ userId: 'u1', tokenId: 'tok1' });
    const jwt = sessions.createSession({ userId: 'u1', tokenId: null });
    eventBus.dropToken('tok1');
    expect(sessions.getSession(tok.id, { userId: 'u1', tokenId: 'tok1' })).toBeNull();
    expect(sessions.getSession(jwt.id, { userId: 'u1', tokenId: null })).toBe(jwt);
  });
});

describe('in-flight requests (support ticket 2026-09-12: "session expired" after a committed write)', () => {
  test('expiry or eviction while a request is in flight unroutes the session but keeps its transport until the request ends', async () => {
    const s = sessions.createSession({ userId: 'u1' });
    s.transport = mkTransport();
    s.server = { close: jest.fn().mockResolvedValue() };
    sessions.beginRequest(s);
    expect(sessions.destroySession(s.id, 'evicted_for_new_session')).toBe(true);
    // New requests get 404 (re-initialize), the slot is free …
    expect(sessions.getSession(s.id, { userId: 'u1', tokenId: null })).toBeNull();
    expect(sessions.sessionCounts().total).toBe(0);
    // … but the in-flight response stream is untouched
    expect(s.transport.close).not.toHaveBeenCalled();
    sessions.endRequest(s);
    await Promise.resolve(); await Promise.resolve(); // close() runs off the hot path
    expect(s.transport.close).toHaveBeenCalled();
    expect(s.server.close).toHaveBeenCalled();
  });

  test('a revoked credential still tears the transport down at once, request or not', async () => {
    const s = sessions.createSession({ userId: 'u1', tokenId: 'tok1' });
    s.transport = mkTransport();
    sessions.beginRequest(s);
    eventBus.dropToken('tok1');
    await Promise.resolve(); await Promise.resolve();
    expect(s.transport.close).toHaveBeenCalled();
  });

  test('the per-user cap evicts an idle session before one that is mid-request, even when the busy one is staler', () => {
    const busy = sessions.createSession({ userId: 'u1' });
    busy.transport = mkTransport();
    sessions.beginRequest(busy);
    jest.advanceTimersByTime(1000);
    const idle = sessions.createSession({ userId: 'u1' });
    idle.transport = mkTransport();
    jest.advanceTimersByTime(1000);
    sessions.createSession({ userId: 'u1' });
    jest.setSystemTime(Date.now());
    sessions.createSession({ userId: 'u1' }); // 4th → evicts one
    expect(sessions.getSession(idle.id, { userId: 'u1', tokenId: null })).toBeNull();
    expect(sessions.getSession(busy.id, { userId: 'u1', tokenId: null })).toBe(busy);
  });
});
