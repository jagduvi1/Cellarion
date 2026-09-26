/**
 * The per-user data version the read caches key on (services/dataVersion).
 * A cache stores the version it read before loading and answers from memory
 * while it still matches — so the version must move on every change for that
 * user, never for anyone else, and never hand an old number back.
 */

let dv;
beforeEach(() => {
  jest.isolateModules(() => { dv = require('./dataVersion'); });
});

test('a user never changed reads a stable version', () => {
  expect(dv.getDataVersion('u1')).toBe(dv.getDataVersion('u1'));
});

test('a change moves that user\'s version and nobody else\'s', () => {
  const u1 = dv.getDataVersion('u1');
  const u2 = dv.getDataVersion('u2');
  dv.bumpDataVersion('u1');
  expect(dv.getDataVersion('u1')).not.toBe(u1);
  expect(dv.getDataVersion('u2')).toBe(u2);
});

test('every change gives a new version (ids as ObjectId-likes or strings)', () => {
  const seen = new Set([dv.getDataVersion('u1')]);
  for (let i = 0; i < 5; i++) {
    dv.bumpDataVersion({ toString: () => 'u1' });
    seen.add(dv.getDataVersion('u1'));
  }
  expect(seen.size).toBe(6);
});

test('no user is a no-op', () => {
  expect(() => dv.bumpDataVersion(null)).not.toThrow();
  expect(() => dv.bumpDataVersion(undefined)).not.toThrow();
});

test('when the map is dropped to bound memory, no earlier version comes back', () => {
  // u1 changed early; its cache stored that version.
  dv.bumpDataVersion('u1');
  const cachedU1 = dv.getDataVersion('u1');
  // u2 never changed; its cache stored the base version.
  const cachedU2 = dv.getDataVersion('u2');
  // Fill the map past its bound with other users' changes.
  for (let i = 0; i < 50001; i++) dv.bumpDataVersion(`other-${i}`);
  // Neither old entry may still match (a conservative miss is fine; a hit
  // after changes it could not see would serve stale data).
  expect(dv.getDataVersion('u1')).not.toBe(cachedU1);
  expect(dv.getDataVersion('u2')).not.toBe(cachedU2);
  // And versions keep moving afterwards.
  const before = dv.getDataVersion('u1');
  dv.bumpDataVersion('u1');
  expect(dv.getDataVersion('u1')).not.toBe(before);
});
