/**
 * services/tokenReadCache — the memory behind API-token polls.
 *
 * WHY THIS TEST EXISTS: a cached answer must disappear the moment the user's
 * version moves or its age runs out, and never leak between users or keys.
 * The routes that use it (cellars, notifications) read the version BEFORE
 * loading and store with that version; this file pins the cache's own
 * contract so each route test can stay about its route.
 */
const { createTokenReadCache } = require('./tokenReadCache');

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-09T12:00:00Z')); });
afterEach(() => { jest.useRealTimers(); });

test('an entry is answered while the version it was stored at still holds', () => {
  const cache = createTokenReadCache();
  cache.set('u1', 'list', 7, { a: 1 });
  expect(cache.get('u1', 'list', 7)).toEqual({ a: 1 });
});

test('a moved version is a miss, and the stale entry is dropped', () => {
  const cache = createTokenReadCache();
  cache.set('u1', 'list', 7, { a: 1 });
  expect(cache.get('u1', 'list', 8)).toBeUndefined();
  expect(cache.size).toBe(0);
});

test('an entry older than the max age is a miss', () => {
  const cache = createTokenReadCache({ maxAgeMs: 10 * 60 * 1000 });
  cache.set('u1', 'list', 7, { a: 1 });
  jest.advanceTimersByTime(10 * 60 * 1000 - 1);
  expect(cache.get('u1', 'list', 7)).toEqual({ a: 1 });
  jest.advanceTimersByTime(2);
  expect(cache.get('u1', 'list', 7)).toBeUndefined();
});

test('users and keys never share an entry', () => {
  const cache = createTokenReadCache();
  cache.set('u1', 'list', 7, { who: 'u1' });
  expect(cache.get('u2', 'list', 7)).toBeUndefined();
  expect(cache.get('u1', 'probe', 7)).toBeUndefined();
  // An id as an ObjectId-like and as a string are the same user.
  expect(cache.get({ toString: () => 'u1' }, 'list', 7)).toEqual({ who: 'u1' });
});

test('a full cache starts over instead of growing', () => {
  const cache = createTokenReadCache({ maxEntries: 2 });
  cache.set('u1', 'list', 1, 1);
  cache.set('u2', 'list', 1, 2);
  cache.set('u2', 'list', 2, 3); // replacing an entry needs no room
  expect(cache.size).toBe(2);
  cache.set('u3', 'list', 1, 4);
  expect(cache.size).toBe(1);
  expect(cache.get('u1', 'list', 1)).toBeUndefined();
  expect(cache.get('u3', 'list', 1)).toBe(4);
});
