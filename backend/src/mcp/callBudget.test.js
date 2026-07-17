/**
 * MCP cross-request call budget (security audit M-4).
 *
 * Bounds read amplification: the per-request cap and per-IP HTTP limiter count
 * requests, not tool calls, so without this a caller could drive thousands of
 * reads per window. These tests pin the rolling-window counter, the per-caller
 * keying (user vs anon IP), and the window rollover.
 */

jest.mock('../utils/clientIp', () => ({ getClientIp: (req) => req?.ip || 'anon' }));

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

test('withinCallBudget charges one slot for the caller', () => {
  const ctx = { user: { id: `budget-user-${now}` } };
  // Far below USER_CALL_MAX, so always true — just proves it charges without throwing.
  for (let i = 0; i < 10; i++) expect(withinCallBudget(ctx)).toBe(true);
});
