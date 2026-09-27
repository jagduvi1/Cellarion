/**
 * utils/loginAttempts: per-account lockout after repeated wrong passwords.
 *
 * WHY THE COUNTER TESTS LOOK LIKE THIS:
 * Until 2026-09-27 the counter was read with the user at the start of a login
 * request and written back with user.save(). Guesses sent at the same moment
 * all read the same count and overwrote each other: 40 wrong passwords at once
 * were counted as 4 or less, and the account never locked. Now each failure is
 * one atomic update (failureUpdate) that MongoDB applies to the stored state.
 *
 * nextFailureState is the same transition as plain JS: it is what the tests
 * pin down, and the fake model below applies it atomically the way MongoDB
 * applies the pipeline, so the concurrency test is meaningful. That the
 * pipeline really equals nextFailureState is checked against a real MongoDB in
 * the Docker smoke test (see the PR).
 */

const mockState = { docs: new Map(), nowMs: 0, updates: [] };

jest.mock('../models/User', () => {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v), (k, x) => (
    typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) ? new Date(x) : x
  )));
  const lean = (value) => ({ lean: async () => { await null; return value; } });
  return {
    // Applied at call time, in call order: the atomic update MongoDB performs.
    findOneAndUpdate: jest.fn((filter, update, options) => {
      mockState.updates.push({ filter, update, options });
      const doc = mockState.docs.get(String(filter._id));
      if (!doc) return lean(null);
      const before = clone(doc);
      const { nextFailureState } = jest.requireActual('./loginAttempts');
      const rateLimitsConfig = jest.requireActual('../config/rateLimits');
      doc.failedLoginAttempts = nextFailureState(doc.failedLoginAttempts, mockState.nowMs, rateLimitsConfig.get().accountLockout).state;
      return lean(before);
    }),
    updateOne: jest.fn(async (filter, update) => {
      const doc = mockState.docs.get(String(filter._id));
      if (!doc) return { modifiedCount: 0 };
      const sent = doc.failedLoginAttempts?.lockoutEmailSentAt;
      const cutoff = filter.$or[1]['failedLoginAttempts.lockoutEmailSentAt'].$lt;
      if (sent && !(new Date(sent) < cutoff)) return { modifiedCount: 0 };
      doc.failedLoginAttempts.lockoutEmailSentAt = update.$set['failedLoginAttempts.lockoutEmailSentAt'];
      return { modifiedCount: 1 };
    }),
    findById: jest.fn((id) => ({ select() { return lean(clone(mockState.docs.get(String(id)))); } })),
  };
});

const User = require('../models/User');
const {
  isAccountLocked,
  isAccountLockedNow,
  nextFailureState,
  failureUpdate,
  recordLoginFailure,
  resetLoginAttempts,
} = require('./loginAttempts');
const rateLimitsConfig = require('../config/rateLimits');

// Snapshot + restore the in-memory config so tests can tweak thresholds
// without affecting the order they run in.
const originalConfig = JSON.parse(JSON.stringify(rateLimitsConfig.get()));
afterEach(() => rateLimitsConfig.set(JSON.parse(JSON.stringify(originalConfig))));

beforeEach(() => {
  mockState.docs.clear();
  mockState.updates.length = 0;
  jest.clearAllMocks();
});

function makeUser(failedLoginAttempts) {
  return {
    failedLoginAttempts,
    markModified: jest.fn(),
  };
}

// A stored user for the atomic path. Returns its id.
function storeUser(failedLoginAttempts) {
  const id = `u${mockState.docs.size + 1}`;
  mockState.docs.set(id, { _id: id, ...(failedLoginAttempts === undefined ? {} : { failedLoginAttempts }) });
  return id;
}
const stored = (id) => mockState.docs.get(id).failedLoginAttempts;

// One failed login at nowMs (the fake model applies the transition with it).
function fail(id, nowMs) {
  mockState.nowMs = nowMs;
  return recordLoginFailure(id, nowMs);
}

function setLockoutConfig(overrides) {
  const cfg = rateLimitsConfig.get();
  rateLimitsConfig.set({
    ...cfg,
    accountLockout: { ...cfg.accountLockout, ...overrides },
  });
}
const lockout = () => rateLimitsConfig.get().accountLockout;

const HOUR = 60 * 60 * 1000;
const MIN  = 60 * 1000;

describe('isAccountLocked', () => {
  it('returns false when failedLoginAttempts is missing', () => {
    expect(isAccountLocked({})).toBe(false);
    expect(isAccountLocked(null)).toBe(false);
    expect(isAccountLocked(undefined)).toBe(false);
  });

  it('returns false when lockedUntil is null', () => {
    expect(isAccountLocked(makeUser({ count: 0, lockedUntil: null }))).toBe(false);
  });

  it('returns false when lockedUntil is in the past', () => {
    const user = makeUser({ count: 10, lockedUntil: new Date(Date.now() - 1000) });
    expect(isAccountLocked(user)).toBe(false);
  });

  it('returns true when lockedUntil is in the future', () => {
    const user = makeUser({ count: 10, lockedUntil: new Date(Date.now() + HOUR) });
    expect(isAccountLocked(user)).toBe(true);
  });
});

describe('nextFailureState (the transition the database update applies)', () => {
  it('starts a legacy user with no failedLoginAttempts at 1', () => {
    const r = nextFailureState(undefined, 1_000_000, lockout());
    expect(r).toMatchObject({ alreadyLocked: false, lockedNow: false });
    expect(r.state).toEqual({ count: 1, firstFailedAt: new Date(1_000_000), lockedUntil: null, lockoutEmailSentAt: null });
  });

  it('increments within the window and keeps when the run started', () => {
    const r = nextFailureState({ count: 2, firstFailedAt: new Date(1_000_000), lockedUntil: null }, 1_000_020, lockout());
    expect(r.state.count).toBe(3);
    expect(r.state.firstFailedAt).toEqual(new Date(1_000_000));
  });

  it('starts again at 1 when the previous run is outside the window (decay)', () => {
    setLockoutConfig({ windowMs: 15 * MIN });
    const nowMs = 1_000_000 + 20 * MIN;
    const r = nextFailureState({ count: 5, firstFailedAt: new Date(1_000_000), lockedUntil: null }, nowMs, lockout());
    expect(r.state.count).toBe(1);
    expect(r.state.firstFailedAt).toEqual(new Date(nowMs));
  });

  it('locks exactly at the threshold, for durationMs', () => {
    setLockoutConfig({ threshold: 3, durationMs: HOUR });
    const r = nextFailureState({ count: 2, firstFailedAt: new Date(1_000_000), lockedUntil: null }, 1_000_020, lockout());
    expect(r.lockedNow).toBe(true);
    expect(r.state.lockedUntil).toEqual(new Date(1_000_020 + HOUR));
  });

  it('changes nothing while locked', () => {
    const prev = { count: 3, firstFailedAt: new Date(1_000_000), lockedUntil: new Date(2_000_000), lockoutEmailSentAt: null };
    const r = nextFailureState(prev, 1_500_000, lockout());
    expect(r).toEqual({ alreadyLocked: true, lockedNow: false, state: prev });
  });

  it('keeps lockoutEmailSentAt (the email is claimed separately)', () => {
    const sent = new Date(900_000);
    expect(nextFailureState({ count: 0, lockoutEmailSentAt: sent }, 1_000_000, lockout()).state.lockoutEmailSentAt).toEqual(sent);
  });
});

describe('failureUpdate', () => {
  it('is one $set stage replacing failedLoginAttempts, built from now, the window, the threshold and the duration', () => {
    setLockoutConfig({ threshold: 7, windowMs: 15 * MIN, durationMs: HOUR });
    const pipeline = failureUpdate(1_000_000_000, lockout());
    expect(pipeline).toHaveLength(1);
    expect(Object.keys(pipeline[0])).toEqual(['$set']);
    expect(Object.keys(pipeline[0].$set)).toEqual(['failedLoginAttempts']);
    const text = JSON.stringify(pipeline);
    expect(text).toContain(JSON.stringify(new Date(1_000_000_000)));
    expect(text).toContain(JSON.stringify(new Date(1_000_000_000 - 15 * MIN)));
    expect(text).toContain(JSON.stringify(new Date(1_000_000_000 + HOUR)));
    expect(text).toContain('{"$gte":["$$count",7]}');
  });
});

describe('recordLoginFailure', () => {
  it('sends the transition as one atomic update on the user, asking for the state it replaced', async () => {
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    await fail(id, 1_000_000);
    expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const { filter, update, options } = mockState.updates[0];
    expect(filter).toEqual({ _id: id });
    expect(update).toEqual(failureUpdate(1_000_000, lockout()));
    expect(options).toMatchObject({ new: false });
    expect(stored(id).count).toBe(1);
  });

  it('counts a legacy user with no failedLoginAttempts from 1', async () => {
    const id = storeUser(undefined);
    expect(await fail(id, 1_000_000)).toEqual({ lockedNow: false, alreadyLocked: false, shouldSendEmail: false });
    expect(stored(id)).toMatchObject({ count: 1, firstFailedAt: new Date(1_000_000) });
  });

  it('locks at the threshold and claims the alert email once', async () => {
    setLockoutConfig({ threshold: 3, durationMs: HOUR });
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    await fail(id, 1_000_000);
    await fail(id, 1_000_010);
    const result = await fail(id, 1_000_020);
    expect(result).toEqual({ lockedNow: true, alreadyLocked: false, shouldSendEmail: true });
    expect(stored(id).lockedUntil).toEqual(new Date(1_000_020 + HOUR));
    expect(stored(id).lockoutEmailSentAt).toEqual(new Date(1_000_020));
  });

  it('does not count further while locked', async () => {
    setLockoutConfig({ threshold: 3 });
    const id = storeUser({ count: 3, firstFailedAt: new Date(1_000_000), lockedUntil: new Date(2_000_000), lockoutEmailSentAt: null });
    expect(await fail(id, 1_500_000)).toEqual({ lockedNow: false, alreadyLocked: true, shouldSendEmail: false });
    expect(stored(id).count).toBe(3);
  });

  it('does NOT re-send the email within the dedupe window', async () => {
    setLockoutConfig({ threshold: 2, windowMs: 1000, durationMs: 500, emailDedupMs: HOUR });
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: new Date(1_000_000) });
    await fail(id, 1_000_600);
    const result = await fail(id, 1_000_700);
    expect(result).toEqual({ lockedNow: true, alreadyLocked: false, shouldSendEmail: false });
    expect(stored(id).lockoutEmailSentAt).toEqual(new Date(1_000_000));
  });

  it('DOES send another email after the dedupe window expires', async () => {
    setLockoutConfig({ threshold: 2, windowMs: 1000, durationMs: 500, emailDedupMs: 100 });
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: new Date(1_000_000) });
    await fail(id, 1_001_000);
    expect((await fail(id, 1_001_010)).shouldSendEmail).toBe(true);
  });

  it('the lock is still reported when claiming the email fails, just without the email', async () => {
    setLockoutConfig({ threshold: 1 });
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    User.updateOne.mockRejectedValueOnce(new Error('write conflict'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fail(id, 1_000_000)).toEqual({ lockedNow: true, alreadyLocked: false, shouldSendEmail: false });
    warn.mockRestore();
  });

  it('a user deleted meanwhile: nothing to count', async () => {
    expect(await fail('gone', 1_000_000)).toEqual({ lockedNow: false, alreadyLocked: false, shouldSendEmail: false });
  });

  it('40 wrong passwords at the same moment: every one counts, the account locks once, one email', async () => {
    setLockoutConfig({ threshold: 10, windowMs: 15 * MIN, durationMs: HOUR, emailDedupMs: HOUR });
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    mockState.nowMs = 1_000_000;
    const results = await Promise.all(Array.from({ length: 40 }, () => recordLoginFailure(id, 1_000_000)));
    expect(stored(id).count).toBe(10);
    expect(isAccountLocked({ failedLoginAttempts: stored(id) }, 1_000_001)).toBe(true);
    expect(results.filter((r) => r.lockedNow)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyLocked)).toHaveLength(30);
    expect(results.filter((r) => r.shouldSendEmail)).toHaveLength(1);
  });
});

describe('isAccountLockedNow', () => {
  it('reads the lock as stored now, not as the request loaded it', async () => {
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null });
    expect(await isAccountLockedNow(id, 1_000_000)).toBe(false);
    stored(id).lockedUntil = new Date(1_000_000 + HOUR);
    expect(await isAccountLockedNow(id, 1_000_000)).toBe(true);
    expect(await isAccountLockedNow(id, 1_000_000 + 2 * HOUR)).toBe(false);
    expect(await isAccountLockedNow('gone', 1_000_000)).toBe(false);
  });
});

describe('resetLoginAttempts', () => {
  it('clears the counter and lockedUntil', () => {
    const user = makeUser({
      count: 5,
      firstFailedAt: new Date(1_000_000),
      lockedUntil: new Date(Date.now() + HOUR),
      lockoutEmailSentAt: new Date(1_000_000),
    });
    const cleared = resetLoginAttempts(user);
    expect(cleared).toBe(true);
    expect(user.failedLoginAttempts.count).toBe(0);
    expect(user.failedLoginAttempts.firstFailedAt).toBeNull();
    expect(user.failedLoginAttempts.lockedUntil).toBeNull();
    expect(user.markModified).toHaveBeenCalledWith('failedLoginAttempts');
  });

  it('preserves lockoutEmailSentAt so post-recovery dedupe still works', () => {
    const emailSent = new Date(1_000_000);
    const user = makeUser({
      count: 5,
      firstFailedAt: new Date(1_000_000),
      lockedUntil: new Date(Date.now() + HOUR),
      lockoutEmailSentAt: emailSent,
    });
    resetLoginAttempts(user);
    expect(user.failedLoginAttempts.lockoutEmailSentAt).toEqual(emailSent);
  });

  it('is a no-op when nothing to clear', () => {
    const user = makeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    const cleared = resetLoginAttempts(user);
    expect(cleared).toBe(false);
    expect(user.markModified).not.toHaveBeenCalled();
  });

  it('handles missing failedLoginAttempts subdoc', () => {
    const user = { markModified: jest.fn() };
    expect(resetLoginAttempts(user)).toBe(false);
    expect(user.markModified).not.toHaveBeenCalled();
  });

  it('handles null/undefined user gracefully', () => {
    expect(resetLoginAttempts(null)).toBe(false);
    expect(resetLoginAttempts(undefined)).toBe(false);
  });
});

describe('integration — full lifecycle', () => {
  it('threshold trip → silent rejection while locked → unlock after duration → fresh counter past window', async () => {
    // Tight numbers to make the timeline easy to follow:
    //   threshold 3, window 100ms, lock duration 500ms, email dedupe 10s
    setLockoutConfig({ threshold: 3, windowMs: 100, durationMs: 500, emailDedupMs: 10_000 });
    const id = storeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });

    // t=1000..1020: 3 failures → locked until t=1520
    await fail(id, 1000);
    await fail(id, 1010);
    const lockResult = await fail(id, 1020);
    expect(lockResult.lockedNow).toBe(true);
    expect(await isAccountLockedNow(id, 1100)).toBe(true);  // still locked at t=1100

    // During lock → no-op, alreadyLocked reported
    const duringLock = await fail(id, 1100);
    expect(duringLock.alreadyLocked).toBe(true);
    expect(stored(id).count).toBe(3);  // counter not incremented during lock

    // Past lock + past window (firstFailedAt=1000, window=100 → expired at 1100;
    // we're at 1600). Counter should reset to 1.
    const after = await fail(id, 1600);
    expect(after.alreadyLocked).toBe(false);
    expect(after.lockedNow).toBe(false);
    expect(stored(id).count).toBe(1);
    expect(stored(id).firstFailedAt).toEqual(new Date(1600));
  });
});
