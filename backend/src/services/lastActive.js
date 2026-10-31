/**
 * User.lastActiveAt — the last day an account was used.
 *
 * Two ways in:
 *   • markActive(user, at) sets it on a user document a caller is about to
 *     save anyway (services/authTokens.issueTokens: every sign-in, sign-up, SSO
 *     return and session renewal), so a signed-in member costs no extra write.
 *   • touchLastActive(userId, at) is a standalone update for paths that do not
 *     save the user (middleware/apiTokenAuth: an API token or AI connector in
 *     use, once per token per UTC day). Fire-and-forget: it never throws, so a
 *     failed write can never fail the request that triggered it.
 *
 * The value is UTC midnight of the day (a day, nothing finer) and only ever
 * moves forward ($max), so a late or out-of-order write cannot pull it back.
 */
const User = require('../models/User');

/** UTC midnight of the day `at` falls on. */
function activeDay(at = new Date()) {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Set lastActiveAt on a user document (unsaved); moves forward only. */
function markActive(user, at = new Date()) {
  if (!user) return;
  const day = activeDay(at);
  const current = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : null;
  if (current === null || current < day.getTime()) user.lastActiveAt = day;
}

/** Record activity for an account without loading it. Resolves, never rejects. */
function touchLastActive(userId, at = new Date()) {
  try {
    return Promise.resolve(User.updateOne({ _id: userId }, { $max: { lastActiveAt: activeDay(at) } }))
      .then(() => undefined, (err) => {
        console.warn('[lastActive] update failed (non-fatal):', err?.message);
      });
  } catch (err) {
    console.warn('[lastActive] update failed (non-fatal):', err?.message);
    return Promise.resolve();
  }
}

module.exports = { activeDay, markActive, touchLastActive };
