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
 * Record a failed login attempt and (if the threshold is crossed) lock the
 * account. Caller MUST `await user.save()` afterwards. Returns a small
 * status object that lets the caller decide whether to fire a lockout-alert
 * email — exactly once per dedupe window.
 *
 *   { lockedNow, alreadyLocked, shouldSendEmail }
 *
 * @param {object}   user         Mongoose User document (with markModified)
 * @param {number}   [nowMs]      Override for tests (defaults to Date.now())
 * @returns {{ lockedNow: boolean, alreadyLocked: boolean, shouldSendEmail: boolean }}
 */
function recordLoginFailure(user, nowMs = Date.now()) {
  if (!user) return { lockedNow: false, alreadyLocked: false, shouldSendEmail: false };

  // Initialise the subdoc lazily so legacy User documents start with a clean slate.
  if (!user.failedLoginAttempts) {
    user.failedLoginAttempts = { count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null };
  }
  const attempts = user.failedLoginAttempts;

  // If the account is currently locked, don't increment further and don't
  // re-send the email — just report the state to the caller.
  const alreadyLocked = attempts.lockedUntil && attempts.lockedUntil.getTime() > nowMs;
  if (alreadyLocked) {
    return { lockedNow: false, alreadyLocked: true, shouldSendEmail: false };
  }

  const { threshold, windowMs, durationMs, emailDedupMs } = rateLimitsConfig.get().accountLockout;

  // Reset the count if the previous failure was outside the rolling window
  // (the "decay" behaviour — old failures don't haunt the user forever).
  const firstAt = attempts.firstFailedAt?.getTime();
  if (!firstAt || nowMs - firstAt > windowMs) {
    attempts.count = 1;
    attempts.firstFailedAt = new Date(nowMs);
  } else {
    attempts.count = (attempts.count || 0) + 1;
  }

  let lockedNow = false;
  let shouldSendEmail = false;
  if (attempts.count >= threshold) {
    attempts.lockedUntil = new Date(nowMs + durationMs);
    lockedNow = true;

    // Send the alert email at most once per dedupe window — sustained attacks
    // shouldn't spam the user's inbox.
    const lastEmailAt = attempts.lockoutEmailSentAt?.getTime();
    if (!lastEmailAt || nowMs - lastEmailAt > emailDedupMs) {
      shouldSendEmail = true;
      attempts.lockoutEmailSentAt = new Date(nowMs);
    }
  }

  if (typeof user.markModified === 'function') {
    user.markModified('failedLoginAttempts');
  }

  return { lockedNow, alreadyLocked: false, shouldSendEmail };
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
  recordLoginFailure,
  resetLoginAttempts,
};
