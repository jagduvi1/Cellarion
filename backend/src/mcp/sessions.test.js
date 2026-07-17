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
  test('per-user cap: the 4th session is refused; destroy frees a slot', () => {
    const a = sessions.createSession({ userId: 'u1' });
    sessions.createSession({ userId: 'u1' });
    sessions.createSession({ userId: 'u1' });
    expect(sessions.createSession({ userId: 'u1' })).toBeNull();
    expect(sessions.createSession({ userId: 'u2' })).not.toBeNull(); // other users unaffected
    sessions.destroySession(a.id);
    expect(sessions.createSession({ userId: 'u1' })).not.toBeNull();
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
