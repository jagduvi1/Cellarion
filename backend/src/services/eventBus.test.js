/**
 * SSE event bus (docs/ha-push-events.md §1).
 *
 * WHY THIS TEST EXISTS:
 * The bus holds live sockets in module state, so its failure modes are
 * process-wide: an uncaught throw from a half-dead socket would surface inside
 * whatever mutation handler emitted the event; a leaked timer or missed
 * unregister slowly exhausts the caps. These tests pin the debounce/coalesce
 * contract, both caps, cleanup, the write-safety guards, and the two
 * force-close paths (dropUser for credential events, dropToken for revoked
 * API tokens).
 */

const mockRes = () => ({
  written: [],
  destroyed: false,
  writableEnded: false,
  write(frame) { this.written.push(frame); },
  end() { this.writableEnded = true; },
});

let eventBus;
beforeEach(() => {
  jest.resetModules(); // fresh module state per test — the bus is a singleton
  jest.useFakeTimers();
  eventBus = require('./eventBus');
});
afterEach(() => jest.useRealTimers());

describe('emit (debounce + coalesce)', () => {
  test('a burst of emits within the window produces ONE frame — the last event', () => {
    const res = mockRes();
    eventBus.register('u1', res);

    for (let i = 0; i < 50; i++) eventBus.emit('u1', 'stats_changed', { reason: 'bottle.import' });
    eventBus.emit('u1', 'stats_changed', { reason: 'cellar.import' });
    expect(res.written).toHaveLength(0); // nothing before the window closes

    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(res.written).toHaveLength(1);
    expect(res.written[0]).toBe('event: stats_changed\ndata: {"reason":"cellar.import"}\n\n');
  });

  test('emits after the window produce a new frame', () => {
    const res = mockRes();
    eventBus.register('u1', res);
    eventBus.emit('u1', 'stats_changed', {});
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    eventBus.emit('u1', 'notification', { id: 'n1' });
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(res.written).toHaveLength(2);
  });

  test('emit is a no-op for users without streams (no timer leak)', () => {
    eventBus.emit('nobody', 'stats_changed', {});
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS * 2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('all of a user\'s streams get the frame; other users get nothing', () => {
    const a1 = mockRes(); const a2 = mockRes(); const b = mockRes();
    eventBus.register('a', a1);
    eventBus.register('a', a2);
    eventBus.register('b', b);
    eventBus.emit('a', 'stats_changed', {});
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(a1.written).toHaveLength(1);
    expect(a2.written).toHaveLength(1);
    expect(b.written).toHaveLength(0);
  });

  test('a dead socket never throws into the emitter', () => {
    const ok = mockRes();
    const ended = mockRes();
    ended.writableEnded = true;
    const throwing = mockRes();
    throwing.write = () => { throw new Error('EPIPE'); };
    eventBus.register('u1', ok);
    eventBus.register('u1', ended);
    eventBus.register('u1', throwing);

    eventBus.emit('u1', 'stats_changed', {});
    expect(() => jest.advanceTimersByTime(eventBus.DEBOUNCE_MS)).not.toThrow();
    expect(ok.written).toHaveLength(1);
    expect(ended.written).toHaveLength(0);
  });
});

describe('caps', () => {
  test('per-user cap rejects the 6th stream', () => {
    for (let i = 0; i < eventBus.MAX_STREAMS_PER_USER; i++) {
      expect(eventBus.register('u1', mockRes()).ok).toBe(true);
    }
    expect(eventBus.register('u1', mockRes())).toEqual({ ok: false, reason: 'user_cap' });
    // another user is unaffected
    expect(eventBus.register('u2', mockRes()).ok).toBe(true);
  });

  test('global cap rejects new streams across all users', () => {
    const perUser = eventBus.MAX_STREAMS_PER_USER;
    const users = Math.ceil(eventBus.MAX_STREAMS_GLOBAL / perUser);
    let registered = 0;
    for (let u = 0; u < users && registered < eventBus.MAX_STREAMS_GLOBAL; u++) {
      for (let i = 0; i < perUser && registered < eventBus.MAX_STREAMS_GLOBAL; i++) {
        expect(eventBus.register(`user${u}`, mockRes()).ok).toBe(true);
        registered++;
      }
    }
    expect(eventBus.register('one-more', mockRes())).toEqual({ ok: false, reason: 'global_cap' });
    expect(eventBus.streamCounts().total).toBe(eventBus.MAX_STREAMS_GLOBAL);
  });

  test('unregister frees capacity and cleans up per-user state', () => {
    const rs = Array.from({ length: eventBus.MAX_STREAMS_PER_USER }, () => mockRes());
    rs.forEach(r => eventBus.register('u1', r));
    eventBus.unregister('u1', rs[0]);
    expect(eventBus.register('u1', mockRes()).ok).toBe(true);

    // dropping the last stream clears the user entry AND any pending timer
    const solo = mockRes();
    eventBus.register('u9', solo);
    eventBus.emit('u9', 'stats_changed', {});
    eventBus.unregister('u9', solo);
    expect(eventBus.streamCounts().users).toBe(1); // only u1 left
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(solo.written).toHaveLength(0);
  });
});

describe('force-close', () => {
  test('dropUser ends every stream and later emits are no-ops', () => {
    const r1 = mockRes(); const r2 = mockRes();
    eventBus.register('u1', r1);
    eventBus.register('u1', r2, 'tok1');
    eventBus.emit('u1', 'stats_changed', {}); // pending — must be cancelled too

    eventBus.dropUser('u1');
    expect(r1.writableEnded).toBe(true);
    expect(r2.writableEnded).toBe(true);
    expect(eventBus.streamCounts()).toEqual({ total: 0, users: 0 });

    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(r1.written).toHaveLength(0);
  });

  test('dropToken ends only the revoked token\'s streams', () => {
    const jwtStream = mockRes();
    const tokStream = mockRes();
    const otherTok = mockRes();
    eventBus.register('u1', jwtStream);            // JWT-authenticated
    eventBus.register('u1', tokStream, 'tok1');    // the revoked token
    eventBus.register('u2', otherTok, 'tok2');     // a different token

    eventBus.dropToken('tok1');
    expect(tokStream.writableEnded).toBe(true);
    expect(jwtStream.writableEnded).toBe(false);
    expect(otherTok.writableEnded).toBe(false);
    expect(eventBus.streamCounts().total).toBe(2);
  });
});

describe('in-process listeners (MCP sessions, plan §4)', () => {
  test('listeners ride the same debounce as streams and receive (event, data)', () => {
    const got = [];
    eventBus.addListener('u1', (event, data) => got.push([event, data]));
    eventBus.emit('u1', 'notification', { id: 'n1' });
    expect(got).toHaveLength(0); // debounced
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(got).toEqual([['notification', { id: 'n1' }]]);
  });

  test('within a window the LAST event wins (coalesced like streams)', () => {
    const got = [];
    eventBus.addListener('u1', (event) => got.push(event));
    eventBus.emit('u1', 'stats_changed', {});
    eventBus.emit('u1', 'notification', {});
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(got).toEqual(['notification']);
  });

  test('a throwing listener does not break other listeners or streams', () => {
    const res = mockRes();
    eventBus.register('u1', res);
    const got = [];
    eventBus.addListener('u1', () => { throw new Error('boom'); });
    eventBus.addListener('u1', (event) => got.push(event));
    eventBus.emit('u1', 'stats_changed', {});
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(got).toEqual(['stats_changed']);
    expect(res.written).toHaveLength(1);
  });

  test('unsubscribe stops delivery and cleans the per-user set', () => {
    const got = [];
    const unsub = eventBus.addListener('u1', (event) => got.push(event));
    unsub();
    eventBus.emit('u1', 'notification', {});
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(got).toHaveLength(0);
  });

  test('listeners fire even with zero SSE streams registered', () => {
    const got = [];
    eventBus.addListener('u9', (event) => got.push(event));
    eventBus.emit('u9', 'notification', {});
    jest.advanceTimersByTime(eventBus.DEBOUNCE_MS);
    expect(got).toEqual(['notification']);
  });

  test('onDropUser / onDropToken hooks fire before stream teardown', () => {
    const calls = [];
    eventBus.onDropUser((u) => calls.push(['user', u]));
    eventBus.onDropToken((t) => calls.push(['token', t]));
    eventBus.dropUser('u1');
    eventBus.dropToken('tok9');
    expect(calls).toEqual([['user', 'u1'], ['token', 'tok9']]);
  });

  test('a throwing drop hook never blocks the teardown itself', () => {
    const res = mockRes();
    eventBus.register('u1', res);
    eventBus.onDropUser(() => { throw new Error('hook boom'); });
    eventBus.dropUser('u1');
    expect(res.writableEnded).toBe(true);
    expect(eventBus.streamCounts().total).toBe(0);
  });
});
