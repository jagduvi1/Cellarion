/**
 * services/aiBudget — shared per-user daily AI budget + global kill-switch
 * (SECURITY_AUDIT_2026-07-08 M-2/L-14).
 *
 * Debit/refund semantics mirror routes/chat.js: the atomic $inc IS the gate
 * (no check-then-increment race), overshoot is refunded, and a transport-
 * level failure refunds the debit. The global cap is a singleton row with
 * userId: null.
 */

jest.mock('../models/AiUsage', () => {
  const store = new Map(); // `${userId}|${date}` -> { userId, date, count }
  const model = {
    findOneAndUpdate: jest.fn(async (filter, update) => {
      const k = `${filter.userId}|${filter.date}`;
      if (!store.has(k)) store.set(k, { userId: filter.userId, date: filter.date, count: 0 });
      const doc = store.get(k);
      if (update.$inc && typeof update.$inc.count === 'number') doc.count += update.$inc.count;
      return { ...doc };
    }),
    __store: store,
  };
  return model;
});

const AiUsage = require('../models/AiUsage');
const rateLimitsConfig = require('../config/rateLimits');
const { tryDebitAi, isRefundableFailure, todayUTC, secondsUntilMidnightUTC } = require('./aiBudget');

const USER = 'u1';
const userCount = () => AiUsage.__store.get(`${USER}|${todayUTC()}`)?.count ?? 0;
const globalCount = () => AiUsage.__store.get(`null|${todayUTC()}`)?.count ?? 0;

function setLimits({ budget, globalCap }) {
  rateLimitsConfig.set({
    ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)),
    aiDailyBudget: { max: budget },
    aiGlobalDailyCap: { max: globalCap },
  });
}

beforeEach(() => {
  AiUsage.__store.clear();
  jest.clearAllMocks();
  setLimits({ budget: 500, globalCap: 20000 });
});

afterAll(() => {
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

describe('tryDebitAi', () => {
  test('debits one user + one global unit per call', async () => {
    const res = await tryDebitAi(USER);
    expect(res.ok).toBe(true);
    expect(userCount()).toBe(1);
    expect(globalCount()).toBe(1);
  });

  test('the increment is the gate: over-budget call is rejected and refunded', async () => {
    setLimits({ budget: 2, globalCap: 20000 });
    expect((await tryDebitAi(USER)).ok).toBe(true);
    expect((await tryDebitAi(USER)).ok).toBe(true);

    const third = await tryDebitAi(USER);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('user_budget');
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
    // Overshoot refunded — usage stays at the budget, global untouched by the overshoot
    expect(userCount()).toBe(2);
    expect(globalCount()).toBe(2);
  });

  test('global cap trips independently of the user budget and refunds the user debit', async () => {
    setLimits({ budget: 500, globalCap: 1 });
    expect((await tryDebitAi(USER)).ok).toBe(true);

    const second = await tryDebitAi('another-user');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('global_cap');
    // Both the global overshoot AND the other user's debit were refunded
    expect(globalCount()).toBe(1);
    expect(AiUsage.__store.get(`another-user|${todayUTC()}`).count).toBe(0);
  });

  test('0 disables: budget 0 = unlimited, global 0 = kill-switch off (no rows written)', async () => {
    setLimits({ budget: 0, globalCap: 0 });
    const res = await tryDebitAi(USER);
    expect(res.ok).toBe(true);
    expect(AiUsage.__store.size).toBe(0);
    await res.refund(); // must be a harmless no-op
    expect(AiUsage.__store.size).toBe(0);
  });

  test('refund reverses the debit and is idempotent', async () => {
    const res = await tryDebitAi(USER);
    expect(userCount()).toBe(1);
    expect(globalCount()).toBe(1);
    await res.refund();
    expect(userCount()).toBe(0);
    expect(globalCount()).toBe(0);
    await res.refund(); // second call must not double-refund
    expect(userCount()).toBe(0);
    expect(globalCount()).toBe(0);
  });
});

describe('isRefundableFailure', () => {
  test('transport-level failures are refundable', () => {
    expect(isRefundableFailure('rate_limit_exceeded')).toBe(true);
    expect(isRefundableFailure('exception: socket hang up')).toBe(true);
    expect(isRefundableFailure('no_api_key')).toBe(true);
  });

  test('a completed call that answered "unknown" stays debited', () => {
    expect(isRefundableFailure('ai_unknown: not a real wine')).toBe(false);
    expect(isRefundableFailure('missing_name_or_producer_in_response')).toBe(false);
    expect(isRefundableFailure(null)).toBe(false);
  });
});

describe('secondsUntilMidnightUTC', () => {
  test('points at the next UTC midnight', () => {
    const s = secondsUntilMidnightUTC(new Date('2026-07-09T23:59:30Z'));
    expect(s).toBe(30);
    expect(secondsUntilMidnightUTC(new Date('2026-07-09T00:00:00Z'))).toBe(24 * 3600);
  });
});
