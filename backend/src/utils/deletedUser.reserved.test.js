/**
 * isReservedUsername — the names no person may hold.
 *
 * WHY THIS TEST EXISTS:
 * getOrCreateDeletedUser finds the "[deleted]" sentinel BY USERNAME, and every
 * account erasure re-points the erased member's forum threads, replies and
 * reviews at that row. A real account holding the sentinel's name would become
 * the sentinel and inherit all of it. The double-underscore prefix is kept for
 * system accounts, so every '__' name is reserved, in any letter case.
 */
jest.mock('../models/User', () => ({}));

const { isReservedUsername, SENTINEL_USERNAME } = require('./deletedUser');

test('the sentinel name itself is reserved', () => {
  expect(isReservedUsername(SENTINEL_USERNAME)).toBe(true);
  expect(isReservedUsername('__deleted__')).toBe(true);
});

test('the check ignores letter case and surrounding spaces, as the User schema does', () => {
  expect(isReservedUsername('__DELETED__')).toBe(true);
  expect(isReservedUsername('__Deleted__')).toBe(true);
  expect(isReservedUsername('  __deleted__ ')).toBe(true);
});

test('every double-underscore name is reserved', () => {
  expect(isReservedUsername('__system')).toBe(true);
  expect(isReservedUsername('__anything')).toBe(true);
  expect(isReservedUsername('___')).toBe(true);
});

test('ordinary names stay free, including ones with a single underscore or the word itself', () => {
  for (const name of ['deleted', 'deleted__', '_anna', 'a__b', 'anna_', 'jane.doe', 'x-y']) {
    expect(isReservedUsername(name)).toBe(false);
  }
});

test('a missing or non-string name is not reserved (the format check answers those)', () => {
  expect(isReservedUsername(undefined)).toBe(false);
  expect(isReservedUsername(null)).toBe(false);
  expect(isReservedUsername('')).toBe(false);
});
