const {
  isAccountLocked,
  recordLoginFailure,
  resetLoginAttempts,
} = require('./loginAttempts');
const rateLimitsConfig = require('../config/rateLimits');

// Snapshot + restore the in-memory config so tests can tweak thresholds
// without affecting the order they run in.
const originalConfig = JSON.parse(JSON.stringify(rateLimitsConfig.get()));
afterEach(() => rateLimitsConfig.set(JSON.parse(JSON.stringify(originalConfig))));

function makeUser(failedLoginAttempts) {
  return {
    failedLoginAttempts,
    markModified: jest.fn(),
  };
}

function setLockoutConfig(overrides) {
  const cfg = rateLimitsConfig.get();
  rateLimitsConfig.set({
    ...cfg,
    accountLockout: { ...cfg.accountLockout, ...overrides },
  });
}

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
    const past = new Date(Date.now() - HOUR);
    expect(isAccountLocked(makeUser({ count: 12, lockedUntil: past }))).toBe(false);
  });

  it('returns true when lockedUntil is in the future', () => {
    const future = new Date(Date.now() + HOUR);
    expect(isAccountLocked(makeUser({ count: 12, lockedUntil: future }))).toBe(true);
  });
});

describe('recordLoginFailure', () => {
  it('initialises the subdoc on a legacy user with no failedLoginAttempts field', () => {
    const user = { markModified: jest.fn() };
    const result = recordLoginFailure(user, 1_000_000);
    expect(user.failedLoginAttempts).toBeDefined();
    expect(user.failedLoginAttempts.count).toBe(1);
    expect(user.failedLoginAttempts.firstFailedAt).toEqual(new Date(1_000_000));
    expect(result).toEqual({ lockedNow: false, alreadyLocked: false, shouldSendEmail: false });
  });

  it('increments the counter on successive failures within the window', () => {
    const user = makeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    recordLoginFailure(user, 1_000_000);
    recordLoginFailure(user, 1_000_000 + 10);
    recordLoginFailure(user, 1_000_000 + 20);
    expect(user.failedLoginAttempts.count).toBe(3);
    expect(user.failedLoginAttempts.firstFailedAt).toEqual(new Date(1_000_000));
  });

  it('resets the counter when the previous failure is outside the rolling window (decay)', () => {
    setLockoutConfig({ windowMs: 15 * MIN });
    const user = makeUser({
      count: 5,
      firstFailedAt: new Date(1_000_000),
      lockedUntil: null,
      lockoutEmailSentAt: null,
    });
    // 20 minutes later, well past the 15-minute window
    const nowMs = 1_000_000 + 20 * MIN;
    recordLoginFailure(user, nowMs);
    expect(user.failedLoginAttempts.count).toBe(1);
    expect(user.failedLoginAttempts.firstFailedAt).toEqual(new Date(nowMs));
  });

  it('locks the account exactly at the threshold', () => {
    setLockoutConfig({ threshold: 3, durationMs: HOUR });
    const user = makeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    recordLoginFailure(user, 1_000_000);
    recordLoginFailure(user, 1_000_000 + 10);
    const result = recordLoginFailure(user, 1_000_000 + 20);
    expect(result.lockedNow).toBe(true);
    expect(user.failedLoginAttempts.lockedUntil).toEqual(new Date(1_000_000 + 20 + HOUR));
  });

  it('does NOT increment further once already locked', () => {
    setLockoutConfig({ threshold: 3 });
    const future = new Date(2_000_000);
    const user = makeUser({
      count: 3,
      firstFailedAt: new Date(1_000_000),
      lockedUntil: future,
      lockoutEmailSentAt: null,
    });
    const result = recordLoginFailure(user, 1_500_000);
    expect(result.alreadyLocked).toBe(true);
    expect(result.lockedNow).toBe(false);
    expect(result.shouldSendEmail).toBe(false);
    expect(user.failedLoginAttempts.count).toBe(3);  // unchanged
  });

  it('reports shouldSendEmail=true on the first lock event', () => {
    setLockoutConfig({ threshold: 2 });
    const user = makeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    recordLoginFailure(user, 1_000_000);
    const result = recordLoginFailure(user, 1_000_000 + 10);
    expect(result.lockedNow).toBe(true);
    expect(result.shouldSendEmail).toBe(true);
    expect(user.failedLoginAttempts.lockoutEmailSentAt).toEqual(new Date(1_000_000 + 10));
  });

  it('does NOT re-send the email within the dedupe window', () => {
    setLockoutConfig({ threshold: 2, windowMs: 1000, durationMs: 500, emailDedupMs: HOUR });
    const user = makeUser({
      count: 0,
      firstFailedAt: null,
      lockedUntil: null,
      lockoutEmailSentAt: new Date(1_000_000),
    });
    // Lock expires at 1_500. Two new failures right after that re-trigger a lock.
    recordLoginFailure(user, 1_000_600);
    const result = recordLoginFailure(user, 1_000_700);
    expect(result.lockedNow).toBe(true);
    expect(result.shouldSendEmail).toBe(false);   // dedupe still in effect
    // lockoutEmailSentAt unchanged
    expect(user.failedLoginAttempts.lockoutEmailSentAt).toEqual(new Date(1_000_000));
  });

  it('DOES send another email after the dedupe window expires', () => {
    setLockoutConfig({ threshold: 2, windowMs: 1000, durationMs: 500, emailDedupMs: 100 });
    const user = makeUser({
      count: 0,
      firstFailedAt: null,
      lockedUntil: null,
      lockoutEmailSentAt: new Date(1_000_000),
    });
    recordLoginFailure(user, 1_001_000);
    const result = recordLoginFailure(user, 1_001_010);
    expect(result.lockedNow).toBe(true);
    expect(result.shouldSendEmail).toBe(true);
  });

  it('marks the parent path as modified so Mongoose actually persists nested changes', () => {
    const user = makeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    recordLoginFailure(user, 1_000_000);
    expect(user.markModified).toHaveBeenCalledWith('failedLoginAttempts');
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
  it('threshold trip → silent rejection while locked → unlock after duration → fresh counter past window', () => {
    // Tight numbers to make the timeline easy to follow:
    //   threshold 3, window 100ms, lock duration 500ms, email dedupe 10s
    setLockoutConfig({ threshold: 3, windowMs: 100, durationMs: 500, emailDedupMs: 10_000 });
    const user = makeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });

    // t=1000..1020: 3 failures → locked until t=1520
    recordLoginFailure(user, 1000);
    recordLoginFailure(user, 1010);
    const lockResult = recordLoginFailure(user, 1020);
    expect(lockResult.lockedNow).toBe(true);
    expect(isAccountLocked(user, 1100)).toBe(true);  // still locked at t=1100

    // During lock → no-op, alreadyLocked reported
    const duringLock = recordLoginFailure(user, 1100);
    expect(duringLock.alreadyLocked).toBe(true);
    expect(user.failedLoginAttempts.count).toBe(3);  // counter not incremented during lock

    // Past lock + past window (firstFailedAt=1000, window=100 → expired at 1100;
    // we're at 1600). Counter should reset to 1.
    const after = recordLoginFailure(user, 1600);
    expect(after.alreadyLocked).toBe(false);
    expect(after.lockedNow).toBe(false);
    expect(user.failedLoginAttempts.count).toBe(1);
    expect(user.failedLoginAttempts.firstFailedAt).toEqual(new Date(1600));
  });

  it('successful login mid-burst clears everything', () => {
    setLockoutConfig({ threshold: 3 });
    const user = makeUser({ count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null });
    recordLoginFailure(user, 1000);
    recordLoginFailure(user, 1010);
    expect(user.failedLoginAttempts.count).toBe(2);

    resetLoginAttempts(user);

    expect(user.failedLoginAttempts.count).toBe(0);
    expect(isAccountLocked(user)).toBe(false);

    // Future failure starts fresh
    recordLoginFailure(user, 2000);
    expect(user.failedLoginAttempts.count).toBe(1);
  });
});
