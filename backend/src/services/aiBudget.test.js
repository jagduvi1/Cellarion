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

// User model backs the per-user override lookup (getEffectiveDailyMax).
// __setOverride configures what findById resolves for any user.
jest.mock('../models/User', () => {
  const state = { override: null };
  return {
    findById: jest.fn(() => ({
      select: () => ({ lean: async () => ({ aiBudgetOverride: state.override }) }),
    })),
    __setOverride: (o) => { state.override = o; },
  };
});

const AiUsage = require('../models/AiUsage');
const User = require('../models/User');
const rateLimitsConfig = require('../config/rateLimits');
const { tryDebitAi, isRefundableFailure, getEffectiveDailyMax, todayUTC, secondsUntilMidnightUTC } = require('./aiBudget');

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
  User.__setOverride(null);
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

  test('demo accounts are denied with zero spend (no user or global debit)', async () => {
    const res = await tryDebitAi(USER, { isDemo: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('demo_disabled');
    expect(res.retryAfterSeconds).toBeGreaterThan(0);
    // The short-circuit runs BEFORE any AiUsage $inc — nothing is billed.
    expect(userCount()).toBe(0);
    expect(globalCount()).toBe(0);
    expect(AiUsage.findOneAndUpdate).not.toHaveBeenCalled();
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

describe('per-user override (admin-granted AiBudgetRequest)', () => {
  const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
  const past = () => new Date(Date.now() - 60 * 1000);

  test('getEffectiveDailyMax returns the base budget when no override exists', async () => {
    setLimits({ budget: 500, globalCap: 20000 });
    const { max, override } = await getEffectiveDailyMax(USER);
    expect(max).toBe(500);
    expect(override).toBeNull();
  });

  test('an active override raises the effective max', async () => {
    User.__setOverride({ max: 2000, expiresAt: future() });
    const { max, override } = await getEffectiveDailyMax(USER);
    expect(max).toBe(2000);
    expect(override).toEqual({ max: 2000, expiresAt: expect.any(Date) });
  });

  test('an expired override is ignored (no cleanup job needed)', async () => {
    User.__setOverride({ max: 2000, expiresAt: past() });
    const { max, override } = await getEffectiveDailyMax(USER);
    expect(max).toBe(500);
    expect(override).toBeNull();
  });

  test('base 0 (unlimited) is never restricted by an override', async () => {
    setLimits({ budget: 0, globalCap: 20000 });
    User.__setOverride({ max: 2000, expiresAt: future() });
    const { max } = await getEffectiveDailyMax(USER);
    expect(max).toBe(0);
  });

  test('tryDebitAi honors the overridden budget', async () => {
    setLimits({ budget: 1, globalCap: 20000 });
    User.__setOverride({ max: 3, expiresAt: future() });
    expect((await tryDebitAi(USER)).ok).toBe(true);
    expect((await tryDebitAi(USER)).ok).toBe(true); // would fail without override
    expect((await tryDebitAi(USER)).ok).toBe(true);
    const fourth = await tryDebitAi(USER);
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe('user_budget');
    expect(userCount()).toBe(3);
  });

  test('tryDebitAi falls back to base budget once the override expires', async () => {
    setLimits({ budget: 1, globalCap: 20000 });
    User.__setOverride({ max: 3, expiresAt: past() });
    expect((await tryDebitAi(USER)).ok).toBe(true);
    expect((await tryDebitAi(USER)).ok).toBe(false);
  });

  test('a User lookup failure degrades to the base budget (never breaks the call path)', async () => {
    User.findById.mockImplementationOnce(() => ({
      select: () => ({ lean: async () => { throw new Error('db down'); } }),
    }));
    const { max, override } = await getEffectiveDailyMax(USER);
    expect(max).toBe(500);
    expect(override).toBeNull();
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

  test('a completed-but-unparseable response stays debited (audit EXTRA-A)', () => {
    // labelScan.callClaudeJson now tags a post-completion JSON.parse failure as
    // `parse_error:*` (a real billed call) instead of the refundable
    // `exception:*` it used to return from the shared transport catch.
    expect(isRefundableFailure('parse_error: Unexpected token < in JSON')).toBe(false);
  });
});

describe('secondsUntilMidnightUTC', () => {
  test('points at the next UTC midnight', () => {
    const s = secondsUntilMidnightUTC(new Date('2026-07-09T23:59:30Z'));
    expect(s).toBe(30);
    expect(secondsUntilMidnightUTC(new Date('2026-07-09T00:00:00Z'))).toBe(24 * 3600);
  });
});
