/**
 * Drink-window notifier — runs daily via the scheduler.
 *
 * Checks all users' active bottles against WineVintageProfile drink windows
 * and creates in-app (+ push / email) notifications when a bottle transitions
 * to a new maturity status.
 *
 * First run is a "silent seed": it records each bottle's current status
 * without sending notifications, so only future transitions trigger alerts.
 */
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const SiteConfig = require('../models/SiteConfig');
const { CONSUMED_STATUSES } = require('../config/constants');
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
const { createNotification } = require('./notifications');
const { sendDrinkWindowDigest, EMAIL_VERIFICATION_ENABLED } = require('./mailgun');

/**
 * Whether the daily drink-window email digest should be sent to this user.
 *
 * The opt-in lives at `preferences.notifications.drinkWindow.email` — there is
 * NO top-level `notifications.email` flag (see utils/notifications.js). Reading
 * the wrong leaf previously evaluated to `undefined` for everyone and silently
 * disabled the entire digest. Extracted as a pure, testable predicate so that
 * regression is caught by a unit test rather than only in production.
 *
 * @param {object} user  Lean user doc with preferences.notifications + emailVerified
 * @param {boolean} emailVerificationEnabled  Whether the email channel is configured
 * @returns {boolean}
 */
function shouldSendDigestEmail(user, emailVerificationEnabled = EMAIL_VERIFICATION_ENABLED) {
  return Boolean(
    user?.preferences?.notifications?.drinkWindow?.email &&
    emailVerificationEnabled &&
    user?.emailVerified
  );
}

/**
 * Main entry point — called by the scheduler once daily.
 */
async function runDrinkWindowCheck() {
  const seeded = await SiteConfig.findOne({ key: 'drinkWindowNotifierSeeded' }).lean();
  const isFirstRun = !seeded;

  // All users with drink-window notifications not explicitly turned off
  const users = await User.find({
    'preferences.notifications.drinkWindow': { $ne: false }
  }).select('_id email username displayName preferences.notifications emailVerified').lean();

  let totalNotified = 0;

  for (const user of users) {
    try {
      const count = await processUser(user, isFirstRun);
      totalNotified += count;
    } catch (err) {
      console.error(`[drinkWindowNotifier] Error for user ${user._id}:`, err.message);
    }
  }

  if (isFirstRun) {
    await SiteConfig.findOneAndUpdate(
      { key: 'drinkWindowNotifierSeeded' },
      { $set: { key: 'drinkWindowNotifierSeeded', value: new Date().toISOString() } },
      { upsert: true }
    );
    console.log(`[drinkWindowNotifier] First run — seeded ${users.length} users' bottles (no notifications sent)`);
  } else {
    console.log(`[drinkWindowNotifier] Sent ${totalNotified} notification(s)`);
  }
}

/**
 * Process a single user's active bottles.
 * Returns the number of notifications created.
 */
async function processUser(user, isFirstRun) {
  const cellarIds = await Cellar.distinct('_id', { user: user._id, deletedAt: null });
  if (cellarIds.length === 0) return 0;

  const bottles = await Bottle.find({
    user: user._id,
    cellar: { $in: cellarIds },
    status: { $nin: CONSUMED_STATUSES },
    wineDefinition: { $ne: null },
    vintage: { $ne: 'NV' }
  }).populate({ path: 'wineDefinition', select: 'name producer' }).lean();

  if (bottles.length === 0) return 0;

  const profileMap = await buildProfileMap(bottles);
  if (profileMap.size === 0) return 0;

  const currentYear = new Date().getFullYear();
  const alerts = []; // { bottleId, name, vintage, status, notifType }
  const seedOps = []; // first-run status seeds, flushed as one bulkWrite

  for (const bottle of bottles) {
    const maturityStatus = classifyMaturity(bottle, profileMap);
    if (!maturityStatus) continue;

    const wdId = bottle.wineDefinition?._id?.toString();
    const profile = profileMap.get(`${wdId}:${bottle.vintage}`);
    const prevStatus = bottle.drinkWindowNotifiedStatus;

    // Determine notification type based on transition
    let notifType = null;

    if (maturityStatus === 'peak' && prevStatus !== 'peak' && prevStatus !== 'ending') {
      notifType = 'peak';
    } else if (maturityStatus === 'peak' && profile?.peakUntil && (profile.peakUntil - currentYear) <= 1 && prevStatus !== 'ending') {
      notifType = 'ending';
    } else if (maturityStatus === 'declining' && prevStatus !== 'declining') {
      notifType = 'declining';
    } else if (maturityStatus === 'late' && prevStatus !== 'late' && prevStatus !== 'declining') {
      notifType = 'declining'; // treat late as a heads-up too
    }

    // Track the effective status to store (includes "ending" as a distinct state)
    const effectiveStatus = notifType === 'ending' ? 'ending' : maturityStatus;

    if (isFirstRun) {
      // Silent seed: record the current status without sending notifications.
      // Collected into one bulkWrite per user — the first run touches every
      // bottle in the system, and one awaited updateOne per bottle made the
      // seed take hours at scale.
      seedOps.push({
        updateOne: {
          filter: { _id: bottle._id },
          update: { $set: { drinkWindowNotifiedStatus: effectiveStatus, drinkWindowNotifiedAt: new Date() } },
        },
      });
      continue;
    }

    if (!notifType) {
      // No notifiable transition — leave prevStatus alone. Silently
      // rewriting it here used to flip a "sticky" marker like 'ending'
      // back to 'peak' on no-op cron passes (because effectiveStatus
      // falls back to maturityStatus when notifType is null), which then
      // let the ending check re-fire the next day and produced duplicate
      // notifications for the same bottle every other day.
      continue;
    }

    // A notifiable transition
    const wineName = bottle.wineDefinition?.name || 'Unknown wine';
    const vintage  = bottle.vintage;

    alerts.push({
      bottleId: bottle._id,
      cellarId: bottle.cellar,
      wdId,
      name: wineName,
      vintage,
      status: notifType,
    });

    await Bottle.updateOne(
      { _id: bottle._id },
      { $set: { drinkWindowNotifiedStatus: effectiveStatus, drinkWindowNotifiedAt: new Date() } }
    );
  }

  if (seedOps.length > 0) {
    await Bottle.bulkWrite(seedOps, { ordered: false });
  }

  if (alerts.length === 0) return 0;

  // Dedup at the (wine, vintage, status) level so a user with N bottles of
  // the same wine vintage gets ONE notification when they all transition
  // together, not N copies of the same line. Bottle-level prevStatus is
  // still updated for every bottle above, so a second transition (e.g.
  // peak → ending) still fires exactly one new notification when it
  // happens, rather than re-notifying for the same status.
  const uniqueAlerts = [];
  const seenKeys = new Set();
  for (const alert of alerts) {
    const key = `${alert.wdId}:${alert.vintage}:${alert.status}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueAlerts.push(alert);
    }
  }

  // Create in-app notifications (also triggers push via the notification service)
  for (const alert of uniqueAlerts) {
    const { title, message, type } = buildNotification(alert);
    const link = `/cellars/${alert.cellarId}?search=${encodeURIComponent(alert.name)}`;
    await createNotification(user._id, type, title, message, link);
  }

  // Send email digest if opted in (preferences.notifications.drinkWindow.email).
  if (shouldSendDigestEmail(user)) {
    try {
      await sendDrinkWindowDigest(
        user.email,
        user.displayName || user.username,
        uniqueAlerts,
        user._id
      );
    } catch (err) {
      console.error(`[drinkWindowNotifier] Email failed for ${user._id}:`, err.message);
    }
  }

  return uniqueAlerts.length;
}

function buildNotification(alert) {
  const { name, vintage, status } = alert;
  const wine = `${name} ${vintage}`;

  switch (status) {
    case 'peak':
      return {
        type: 'drink_window_peak',
        title: 'At peak maturity',
        message: `${wine} has entered its peak drinking window — time to enjoy it!`
      };
    case 'ending':
      return {
        type: 'drink_window_ending',
        title: 'Peak ending soon',
        message: `${wine} is nearing the end of its peak window — don't miss it!`
      };
    case 'declining':
    default:
      return {
        type: 'drink_window_past',
        title: 'Past its window',
        message: `${wine} has passed its drinking window — drink soon if at all.`
      };
  }
}

module.exports = { runDrinkWindowCheck, shouldSendDigestEmail };
