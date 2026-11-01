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
const SiteConfig = require('../models/SiteConfig');

// When this install started recording lastActiveAt (SiteConfig, set once at
// the first boot that has the field). Before that day nobody's use was
// recorded, so nothing may be concluded from its absence: the inactive-account
// rule never counts an account as unused from earlier than this day.
const TRACKING_KEY = 'lastActiveTracking';

/** UTC midnight of the day `at` falls on. */
function activeDay(at = new Date()) {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Record today as the tracking start unless one is recorded (server boot). */
async function ensureTrackingSince(now = new Date()) {
  await SiteConfig.updateOne(
    { key: TRACKING_KEY },
    { $setOnInsert: { key: TRACKING_KEY, value: { since: activeDay(now) }, updatedAt: now } },
    { upsert: true },
  );
}

/**
 * The day this install started recording lastActiveAt. When none is recorded
 * yet, today: the most cautious answer, since it means nobody has been
 * watched long enough to be called unused.
 */
async function getTrackingSince(now = new Date()) {
  const doc = await SiteConfig.findOne({ key: TRACKING_KEY }).lean();
  const since = doc?.value?.since ? new Date(doc.value.since) : null;
  return since && !Number.isNaN(since.getTime()) ? since : activeDay(now);
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

module.exports = { activeDay, markActive, touchLastActive, ensureTrackingSince, getTrackingSince, TRACKING_KEY };
