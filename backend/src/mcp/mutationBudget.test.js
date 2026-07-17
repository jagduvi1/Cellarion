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
const { takeMutationSlot, ipKeyFor, WRITE_WINDOW_MS, IP_WRITE_MULTIPLIER } = require('./mutationBudget');

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

// Security audit L-18: a per-IP write budget bounds the amplification of many
// distinct accounts sharing one NAT. Per-user cap 5, per-IP cap 5×4 = 20.
test('a shared IP is capped across distinct users at max × IP_WRITE_MULTIPLIER', () => {
  const ip = `ip-${now}`;
  const perIpCap = 5 * IP_WRITE_MULTIPLIER; // 20
  // Each distinct user can spend its full 5, but the IP tops out at 20.
  let spent = 0;
  for (let i = 0; spent < perIpCap; i++) {
    expect(takeMutationSlot(`shared-${i}-${now}`, 5, ip)).toBe(true);
    spent += 5;
  }
  // A brand-new user still has per-user room, but the IP budget is exhausted.
  expect(takeMutationSlot(`shared-final-${now}`, 1, ip)).toBe(false);
});

test('all-or-nothing across BOTH dimensions — an IP-blocked call takes nothing per-user', () => {
  const ip = `ip2-${now}`;
  // Fill the IP window to its cap (20) via other users.
  for (let i = 0; i < 4; i++) expect(takeMutationSlot(`filler-${i}-${now}`, 5, ip)).toBe(true);
  const u = `victim-${now}`;
  expect(takeMutationSlot(u, 5, ip)).toBe(false); // fits per-user but IP is full
  // Because the refused call took nothing per-user, a call WITHOUT the ip key
  // (fresh window) still has the full per-user budget available.
  expect(takeMutationSlot(u, 5)).toBe(true);
});

test('ipKeyFor returns null without a request, a stable key with one', () => {
  expect(ipKeyFor({})).toBeNull();
  expect(ipKeyFor({ req: { ip: '203.0.113.7', headers: {} } })).toBe('203.0.113.7');
});

// MCP-audit M11 / security-audit L-18: the cap eviction replaced a wholesale
// .clear() (which wiped EVERY in-flight window when a burst of distinct keys hit
// the cap). This was claimed-but-untested. Fresh module for a clean map so the
// insertion order — and thus which keys land in the evicted oldest half — is
// deterministic.
test('at WINDOWS_MAX it evicts the OLDEST half, not everyone', () => {
  jest.isolateModules(() => {
    const { takeMutationSlot } = require('./mutationBudget'); // max = 5 (mocked)
    // Older keys fill the first half; then a recent caller spends its full cap.
    for (let i = 0; i < 2600; i++) takeMutationSlot(`old-${i}`, 1);
    expect(takeMutationSlot('recent', 5)).toBe(true);
    expect(takeMutationSlot('recent', 1)).toBe(false); // exhausted
    // Overflow past WINDOWS_MAX (5000) → evicts the oldest 2500 (old-0..old-2499).
    for (let i = 0; i < 2500; i++) takeMutationSlot(`fill-${i}`, 1);
    // `recent` was inserted after the evicted range, so its exhausted window
    // SURVIVED the burst. A `.clear()` would have reset it → this would be true.
    expect(takeMutationSlot('recent', 1)).toBe(false);
  });
});
