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
      // Silent seed: record the current status without sending notifications
      await Bottle.updateOne(
        { _id: bottle._id },
        { $set: { drinkWindowNotifiedStatus: effectiveStatus, drinkWindowNotifiedAt: new Date() } }
      );
      continue;
    }

    if (!notifType) {
      // No transition — update status if changed but don't notify
      if (prevStatus !== effectiveStatus) {
        await Bottle.updateOne(
          { _id: bottle._id },
          { $set: { drinkWindowNotifiedStatus: effectiveStatus, drinkWindowNotifiedAt: new Date() } }
        );
      }
      continue;
    }

    // A notifiable transition
    const wineName = bottle.wineDefinition?.name || 'Unknown wine';
    const vintage  = bottle.vintage;

    alerts.push({ bottleId: bottle._id, cellarId: bottle.cellar, name: wineName, vintage, status: notifType });

    await Bottle.updateOne(
      { _id: bottle._id },
      { $set: { drinkWindowNotifiedStatus: effectiveStatus, drinkWindowNotifiedAt: new Date() } }
    );
  }

  if (alerts.length === 0) return 0;

  // Create in-app notifications (also triggers push via the notification service)
  for (const alert of alerts) {
    const { title, message, type } = buildNotification(alert);
    const link = `/cellars/${alert.cellarId}?search=${encodeURIComponent(alert.name)}`;
    await createNotification(user._id, type, title, message, link);
  }

  // Send email digest if opted in
  if (user.preferences?.notifications?.email && EMAIL_VERIFICATION_ENABLED && user.emailVerified) {
    try {
      await sendDrinkWindowDigest(
        user.email,
        user.displayName || user.username,
        alerts
      );
    } catch (err) {
      console.error(`[drinkWindowNotifier] Email failed for ${user._id}:`, err.message);
    }
  }

  return alerts.length;
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

module.exports = { runDrinkWindowCheck };
