/**
 * Per-account brute-force protection — credential-stuffing kill switch.
 *
 * Why this exists: the per-IP authLimiter (10 failed logins / 15 min / IP)
 * does nothing against a credential-stuffing attacker rotating residential
 * proxies — each IP gets a fresh 10-attempt budget against the same account.
 * This module adds a SECOND counter that lives on the User document itself.
 * After N failed attempts within a window the account is locked for a fixed
 * duration; the lock is silent (same generic 401 + same latency as a normal
 * wrong-password response) so the attacker can't tell they've tripped it.
 *
 * Decay: the counter window slides — if no failure happens for `windowMs`,
 * the next failure starts a fresh count rather than building on stale data.
 *
 * Reset paths:
 *   - successful login            → counter cleared
 *   - successful password reset   → counter cleared (user's explicit recovery signal)
 *
 * Lockout-email dedupe: at most one alert email per `emailDedupMs` window.
 * Otherwise a sustained attack would flood the legitimate user's inbox.
 */
const User = require('../models/User');
const rateLimitsConfig = require('../config/rateLimits');

/**
 * @param {object}  user
 * @param {number}  [nowMs]  Override for tests (defaults to Date.now())
 * @returns {boolean} true iff `lockedUntil` is in the future.
 *                    Tolerates a missing failedLoginAttempts subdoc — old
 *                    User documents created before this field was added
 *                    behave as "never locked".
 */
function isAccountLocked(user, nowMs = Date.now()) {
  const lockedUntil = user?.failedLoginAttempts?.lockedUntil;
  if (!lockedUntil) return false;
  return lockedUntil.getTime() > nowMs;
}

/**
 * Pure: what one more failed login does to the lockout state `prev` (the
 * failedLoginAttempts subdoc, possibly missing on legacy users).
 * recordLoginFailure applies exactly this in the database, atomically
 * (failureUpdate), then reads what it did by running this on the state it
 * replaced.
 *
 *   - already locked            -> nothing changes
 *   - no failure in the window  -> count starts again at 1 (decay)
 *   - count reaches threshold   -> locked for durationMs
 */
function nextFailureState(prev, nowMs, { threshold, windowMs, durationMs }) {
  const a = prev || {};
  const lockedUntilMs = a.lockedUntil ? new Date(a.lockedUntil).getTime() : null;
  if (lockedUntilMs && lockedUntilMs > nowMs) {
    return { alreadyLocked: true, lockedNow: false, state: a };
  }
  const firstAt = a.firstFailedAt ? new Date(a.firstFailedAt).getTime() : null;
  const fresh = !firstAt || nowMs - firstAt > windowMs;
  const count = fresh ? 1 : (a.count || 0) + 1;
  const lockedNow = count >= threshold;
  return {
    alreadyLocked: false,
    lockedNow,
    state: {
      count,
      firstFailedAt: fresh ? new Date(nowMs) : a.firstFailedAt,
      lockedUntil: lockedNow ? new Date(nowMs + durationMs) : (a.lockedUntil ?? null),
      lockoutEmailSentAt: a.lockoutEmailSentAt ?? null,
    },
  };
}

/**
 * nextFailureState as one update pipeline, so MongoDB applies it atomically.
 * Guesses sent at the same moment used to read the same count and overwrite
 * each other's increment (40 at once counted as 4 or less: never locked).
 */
function failureUpdate(nowMs, { threshold, windowMs, durationMs }) {
  const now = new Date(nowMs);
  return [{
    $set: {
      failedLoginAttempts: {
        $let: {
          vars: { a: { $ifNull: ['$failedLoginAttempts', { $literal: {} }] } },
          in: {
            $cond: {
              if: { $gt: ['$$a.lockedUntil', now] },
              then: '$$a',
              else: {
                $let: {
                  vars: {
                    fresh: {
                      $or: [
                        { $eq: [{ $ifNull: ['$$a.firstFailedAt', null] }, null] },
                        { $lt: ['$$a.firstFailedAt', new Date(nowMs - windowMs)] },
                      ],
                    },
                  },
                  in: {
                    $let: {
                      vars: { count: { $cond: ['$$fresh', 1, { $add: [{ $ifNull: ['$$a.count', 0] }, 1] }] } },
                      in: {
                        count: '$$count',
                        firstFailedAt: { $cond: ['$$fresh', now, '$$a.firstFailedAt'] },
                        lockedUntil: {
                          $cond: [{ $gte: ['$$count', threshold] }, new Date(nowMs + durationMs), { $ifNull: ['$$a.lockedUntil', null] }],
                        },
                        lockoutEmailSentAt: { $ifNull: ['$$a.lockoutEmailSentAt', null] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }];
}

/**
 * Record a failed login attempt and (if the threshold is crossed) lock the
 * account, in one atomic update. Returns what the caller needs to decide on
 * the lockout-alert email, which is claimed here so it goes out once per
 * dedupe window however many guesses arrive at once.
 *
 *   { lockedNow, alreadyLocked, shouldSendEmail }
 *
 * @param {ObjectId|string} userId
 * @param {number}          [nowMs]  Override for tests (defaults to Date.now())
 */
async function recordLoginFailure(userId, nowMs = Date.now()) {
  const none = { lockedNow: false, alreadyLocked: false, shouldSendEmail: false };
  if (!userId) return none;
  const cfg = rateLimitsConfig.get().accountLockout;

  const before = await User.findOneAndUpdate(
    { _id: userId },
    failureUpdate(nowMs, cfg),
    { new: false, projection: { failedLoginAttempts: 1 } },
  ).lean();
  if (!before) return none;
  const { alreadyLocked, lockedNow } = nextFailureState(before.failedLoginAttempts, nowMs, cfg);

  // At most one alert email per dedupe window: a sustained attack must not
  // flood the legitimate user's inbox.
  let shouldSendEmail = false;
  if (lockedNow) {
    const claim = await User.updateOne(
      {
        _id: userId,
        $or: [
          { 'failedLoginAttempts.lockoutEmailSentAt': null },
          { 'failedLoginAttempts.lockoutEmailSentAt': { $lt: new Date(nowMs - cfg.emailDedupMs) } },
        ],
      },
      { $set: { 'failedLoginAttempts.lockoutEmailSentAt': new Date(nowMs) } },
    );
    shouldSendEmail = claim.modifiedCount === 1;
  }
  return { lockedNow, alreadyLocked, shouldSendEmail };
}

/**
 * The lock as it stands in the database now, not as it was when the login
 * request loaded the user. A burst of guesses all load the account before any
 * of them locks it; a correct one finishing after the lock took effect must be
 * refused like the rest.
 */
async function isAccountLockedNow(userId, nowMs = Date.now()) {
  const fresh = await User.findById(userId).select('failedLoginAttempts.lockedUntil').lean();
  return isAccountLocked(fresh, nowMs);
}

/**
 * Clear the failed-attempt counter and lockout state. Called on:
 *   - successful login
 *   - successful password reset (the user's explicit recovery signal)
 *
 * Caller is responsible for `await user.save()`. The `lockoutEmailSentAt`
 * is intentionally NOT cleared — a malicious actor's lockout activity stays
 * dedupable across the next failure burst until the dedupe window expires
 * naturally. Avoids a lockout-then-spam pattern where each unsuccessful
 * recovery emits a fresh email.
 *
 * @param {object} user
 * @returns {boolean} true iff state was actually cleared (useful for tests).
 */
function resetLoginAttempts(user) {
  if (!user) return false;
  if (!user.failedLoginAttempts) return false;
  const had = user.failedLoginAttempts.count > 0 || user.failedLoginAttempts.lockedUntil;
  if (!had) return false;
  user.failedLoginAttempts.count = 0;
  user.failedLoginAttempts.firstFailedAt = null;
  user.failedLoginAttempts.lockedUntil = null;
  if (typeof user.markModified === 'function') {
    user.markModified('failedLoginAttempts');
  }
  return true;
}

module.exports = {
  isAccountLocked,
  isAccountLockedNow,
  nextFailureState,
  failureUpdate,
  recordLoginFailure,
  resetLoginAttempts,
};
