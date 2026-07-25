/**
 * MCP cross-request call budget (security audit M-4).
 *
 * Bounds read amplification: the per-request cap and per-IP HTTP limiter count
 * requests, not tool calls, so without this a caller could drive thousands of
 * reads per window. These tests pin the rolling-window counter, the per-caller
 * keying (user vs anon IP), and the window rollover.
 */

// Stub only the IP SOURCE (there is no real socket here); the key derivation
// itself is the genuine implementation, so the /64 assertion below exercises
// real masking rather than a re-implementation of it.
jest.mock('../utils/clientIp', () => {
  const actual = jest.requireActual('../utils/clientIp');
  return {
    getClientIp: (req) => req?.ip || 'anon',
    rateLimitKey: (req) => actual.maskIpForRateLimit(req?.ip || 'anon'),
    maskIpForRateLimit: actual.maskIpForRateLimit,
  };
});

const { takeCallSlot, withinCallBudget, budgetFor, WINDOW_MS, USER_CALL_MAX, PUBLIC_CALL_MAX } = require('./callBudget');

let now = 1_000_000;
beforeEach(() => jest.spyOn(Date, 'now').mockImplementation(() => now));
afterEach(() => jest.restoreAllMocks());

const key = (n) => `k-${n}-${now}`; // unique per test to dodge the module-level map

test('allows calls up to the cap, then refuses; 0/undefined = unlimited', () => {
  const k = key(1);
  for (let i = 0; i < 5; i++) expect(takeCallSlot(k, 5)).toBe(true);
  expect(takeCallSlot(k, 5)).toBe(false);
  // Unlimited sentinel
  for (let i = 0; i < 100; i++) expect(takeCallSlot(key(2), 0)).toBe(true);
});

test('the window rolls over after WINDOW_MS', () => {
  const k = key(3);
  for (let i = 0; i < 5; i++) takeCallSlot(k, 5);
  expect(takeCallSlot(k, 5)).toBe(false);
  now += WINDOW_MS + 1;
  expect(takeCallSlot(k, 5)).toBe(true);
});

test('budgetFor keys an authenticated caller by user id with the user cap', () => {
  const { key: k, max } = budgetFor({ user: { id: 'u1' } });
  expect(k).toBe('u:u1');
  expect(max).toBe(USER_CALL_MAX);
});

test('budgetFor keys the anonymous surface by client IP with the tighter public cap', () => {
  const { key: k, max } = budgetFor({ anonymous: true, req: { ip: '203.0.113.9' } });
  expect(k).toBe('ip:203.0.113.9');
  expect(max).toBe(PUBLIC_CALL_MAX);
  // Falls back to 'anon' when no req/ip is available (unit-test contexts).
  expect(budgetFor({ anonymous: true }).key).toBe('ip:anon');
});

// Security audit 2026-07-25 L-1. This budget used getClientIp (the full /128),
// while the HTTP limiter in front of the same endpoint used rateLimitKey (the
// /64) — so the two disagreed on what "one client" is, and an IPv6 caller
// rotating the low 64 bits of its own prefix collected a fresh 200-call budget
// per address. A single /64 must be a single budget.
test('an IPv6 caller cannot rotate its /64 suffix for a fresh anonymous budget', () => {
  const inSamePrefix = [
    '2001:db8:abcd:1234::1',
    '2001:db8:abcd:1234::dead:beef',
    '2001:db8:abcd:1234:aaaa:bbbb:cccc:dddd',
  ].map((ip) => budgetFor({ anonymous: true, req: { ip } }).key);

  expect(new Set(inSamePrefix).size).toBe(1);
  expect(inSamePrefix[0]).toBe('ip:2001:db8:abcd:1234::/64');

  // A genuinely different /64 is still its own bucket — the masking must not
  // collapse unrelated clients together.
  const otherPrefix = budgetFor({ anonymous: true, req: { ip: '2001:db8:abcd:9999::1' } }).key;
  expect(otherPrefix).not.toBe(inSamePrefix[0]);

  // IPv4 keeps full precision (one address is one client there).
  expect(budgetFor({ anonymous: true, req: { ip: '198.51.100.7' } }).key).toBe('ip:198.51.100.7');
});

test('the shared /64 budget is actually enforced, not just keyed', () => {
  const spend = (ip) => withinCallBudget({ anonymous: true, req: { ip } });
  // Burn the public cap from one address inside the prefix…
  for (let i = 0; i < PUBLIC_CALL_MAX; i++) expect(spend('2001:db8:1:1::1')).toBe(true);
  // …and a "fresh" address in the SAME /64 is already exhausted.
  expect(spend('2001:db8:1:1::2')).toBe(false);
});

test('withinCallBudget charges one slot for the caller', () => {
  const ctx = { user: { id: `budget-user-${now}` } };
  // Far below USER_CALL_MAX, so always true — just proves it charges without throwing.
  for (let i = 0; i < 10; i++) expect(withinCallBudget(ctx)).toBe(true);
});
