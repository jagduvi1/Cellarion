/**
 * mutationBudget — real-execution coverage (grand-audit M24).
 *
 * Every consumer suite pins takeMutationSlot to () => true, so the actual
 * budget logic (all-or-nothing batch charging, the 15-min window rollover, the
 * live rateLimits.write.max read, the clear-at-cap) had never run. An
 * off-by-one here means either unlimited AI writes or all writes blocked.
 */

jest.mock('../config/rateLimits', () => ({ get: jest.fn(() => ({ write: { max: 5 } })) }));

const rateLimits = require('../config/rateLimits');
const { takeMutationSlot, WRITE_WINDOW_MS } = require('./mutationBudget');

let now = 1_000_000;
beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  rateLimits.get.mockReturnValue({ write: { max: 5 } });
});
afterEach(() => jest.restoreAllMocks());

const uid = (n) => `u${n}-${now}`; // unique per test to dodge the module-level map

test('charges single slots up to the cap, then refuses', () => {
  const u = uid(1);
  for (let i = 0; i < 5; i++) expect(takeMutationSlot(u)).toBe(true);
  expect(takeMutationSlot(u)).toBe(false); // 6th over max=5
});

test('batch charge is ALL-OR-NOTHING — a refused batch takes nothing', () => {
  const u = uid(2);
  expect(takeMutationSlot(u, 3)).toBe(true);   // 3/5 used
  expect(takeMutationSlot(u, 3)).toBe(false);  // would be 6 > 5 → refused
  // The refused batch must NOT have consumed anything: 2 slots still remain.
  expect(takeMutationSlot(u, 2)).toBe(true);
  expect(takeMutationSlot(u, 1)).toBe(false);
});

test('the window rolls over after WRITE_WINDOW_MS, resetting the count', () => {
  const u = uid(3);
  for (let i = 0; i < 5; i++) expect(takeMutationSlot(u)).toBe(true);
  expect(takeMutationSlot(u)).toBe(false);
  now += WRITE_WINDOW_MS + 1; // next window
  expect(takeMutationSlot(u)).toBe(true); // fresh budget
});

test('reads the LIVE write.max on each call (admin can tune it down)', () => {
  const u = uid(4);
  expect(takeMutationSlot(u, 5)).toBe(true);
  now += WRITE_WINDOW_MS + 1;
  rateLimits.get.mockReturnValue({ write: { max: 2 } }); // admin lowered it
  expect(takeMutationSlot(u, 3)).toBe(false); // 3 > new cap 2
  expect(takeMutationSlot(u, 2)).toBe(true);
});
