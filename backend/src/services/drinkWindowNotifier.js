/**
 * Drink-window notifier — runs daily via the scheduler.
 *
 * Checks all users' active bottles against WineVintageProfile drink windows
 * and creates in-app (+ push) notifications when a bottle transitions to a new
 * maturity status. The email gathers them: at most one a week
 * (maybeSendDrinkWindowEmail).
 *
 * First run is a "silent seed": it records each bottle's current status
 * without sending notifications, so only future transitions trigger alerts.
 */
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const SiteConfig = require('../models/SiteConfig');
const { NOT_IN_CELLAR_STATUSES, ORDERED_STATUS } = require('../config/constants');
const { isArrivalDue, formatArrivalMonth } = require('../utils/onOrder');
const { classifyMaturity, classifyPersonalWindow, buildProfileMap, resolveWindowForBottle } = require('../utils/maturityUtils');
const { shouldNotifyOpenBottle, openBottleDaysLeft } = require('../utils/openBottleUtils');
const { createNotification } = require('./notifications');
const { sendDrinkWindowDigest, EMAIL_VERIFICATION_ENABLED } = require('./mailgun');

/**
 * Whether this user gets drink-window emails at all (the weekly cap is in
 * maybeSendDrinkWindowEmail).
 *
 * The switch lives at `preferences.notifications.drinkWindow.email` — there is
 * NO top-level `notifications.email` flag (see utils/notifications.js). Reading
 * the wrong leaf previously evaluated to `undefined` for everyone and silently
 * disabled the entire digest. Extracted as a pure, testable predicate so that
 * regression is caught by a unit test rather than only in production.
 *
 * An objection to all Cellarion email (emailOptOutAt, the one-click
 * unsubscribe) wins over the per-category opt-in (audit 2026-09-27 M7).
 *
 * @param {object} user  Lean user doc with preferences.notifications + emailVerified + emailOptOutAt
 * @param {boolean} emailVerificationEnabled  Whether the email channel is configured
 * @returns {boolean}
 */
function shouldSendDigestEmail(user, emailVerificationEnabled = EMAIL_VERIFICATION_ENABLED) {
  return Boolean(
    user?.preferences?.notifications?.drinkWindow?.email &&
    !user?.emailOptOutAt &&
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

  // All users with drink-window notifications not explicitly turned off. The
  // preference is an OBJECT ({ enabled, email, push }), so the old
  // `drinkWindow: { $ne: false }` matched every user (an object is never === false)
  // and the master opt-out did nothing — check the `.enabled` leaf instead.
  const users = await User.find({
    // Exclude both opt-out shapes: the current object form ({ enabled: false })
    // AND a legacy scalar `drinkWindow: false` from the pre-object schema (whose
    // `.enabled` leaf is absent, so the leaf predicate alone would re-include it).
    $and: [
      { 'preferences.notifications.drinkWindow.enabled': { $ne: false } },
      { 'preferences.notifications.drinkWindow': { $ne: false } }
    ]
  }).select('_id email username displayName preferences.notifications emailVerified emailOptOutAt createdAt drinkWindowEmailedAt').lean();

  let totalNotified = 0;
  let failedUsers = 0;

  for (const user of users) {
    try {
      const count = await processUser(user, isFirstRun);
      totalNotified += count;
    } catch (err) {
      failedUsers++;
      console.error(`[drinkWindowNotifier] Error for user ${user._id}:`, err.message);
    }
    try {
      // Open-bottle expiry alerts share the drinkWindow category (and its
      // opt-outs) but not the maturity seed — a bottle can only be open
      // after the feature shipped, so there is nothing to silently seed.
      totalNotified += await processOpenBottles(user);
    } catch (err) {
      console.error(`[drinkWindowNotifier] Open-bottle check failed for user ${user._id}:`, err.message);
    }
    try {
      // Reservation ("spoken for") alerts: same category and no seed, for the
      // same reason — reservations can only exist after the feature shipped.
      totalNotified += await processReservations(user);
    } catch (err) {
      console.error(`[drinkWindowNotifier] Reservation check failed for user ${user._id}:`, err.message);
    }
    try {
      // Orders past their expected month: same category, no seed (bottles on
      // order can only exist after the feature shipped).
      totalNotified += await processArrivals(user);
    } catch (err) {
      console.error(`[drinkWindowNotifier] Arrival check failed for user ${user._id}:`, err.message);
    }
    if (!isFirstRun) {
      try {
        await maybeSendDrinkWindowEmail(user);
      } catch (err) {
        console.error(`[drinkWindowNotifier] Email failed for ${user._id}:`, err.message);
      }
    }
  }

  if (isFirstRun) {
    // Only persist the seeded marker when EVERY user seeded. A user whose
    // seed bulkWrite failed has no recorded statuses — marking the run
    // seeded anyway would treat all their at-peak bottles as fresh
    // transitions on the next run and spam them with notifications.
    if (failedUsers === 0) {
      await SiteConfig.findOneAndUpdate(
        { key: 'drinkWindowNotifierSeeded' },
        { $set: { key: 'drinkWindowNotifierSeeded', value: new Date().toISOString() } },
        { upsert: true }
      );
      console.log(`[drinkWindowNotifier] First run — seeded ${users.length} users' bottles (no notifications sent)`);
    } else {
      console.error(`[drinkWindowNotifier] First-run seed incomplete (${failedUsers} user(s) failed) — marker not set, will re-seed next run`);
    }
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
    status: { $nin: NOT_IN_CELLAR_STATUSES },
    // Profile-classified bottles need a wine definition — including NV
    // bottles, whose curated `relative` profiles are resolved per bottle by
    // classifyMaturity (bottles with no reviewed profile classify to null and
    // are skipped below). A bottle with a PERSONAL drink window
    // (drinkFrom/drinkTo) qualifies regardless, even without a definition.
    $or: [
      { wineDefinition: { $ne: null } },
      { drinkFrom: { $ne: null } },
      { drinkTo: { $ne: null } }
    ]
  }).populate({ path: 'wineDefinition', select: 'name producer' }).lean();

  if (bottles.length === 0) return 0;

  const profileMap = await buildProfileMap(bottles);
  const anyPersonalWindow = bottles.some(b => Number.isFinite(b.drinkFrom) || Number.isFinite(b.drinkTo));
  if (profileMap.size === 0 && !anyPersonalWindow) return 0;

  const currentYear = new Date().getFullYear();
  const alerts = []; // { bottleId, name, vintage, status, notifType }
  const seedOps = []; // first-run status seeds, flushed as one bulkWrite
  const transitionOps = []; // per-transition status updates, flushed as one bulkWrite

  for (const bottle of bottles) {
    const maturityStatus = classifyMaturity(bottle, profileMap);
    if (!maturityStatus) continue;

    // A personal-window bottle whose wine request hasn't been approved yet has
    // NO wineDefinition (it qualified for this query purely via drinkFrom/
    // drinkTo). Its wdId is undefined, so the dedup key `undefined:vintage:status`
    // would collapse every such bottle into ONE "Unknown wine" notification with
    // a dead search link. There's no stable wine identity to notify about yet —
    // skip it (and don't seed it) until it gains a definition; the marker starts
    // null, so the correct alert fires cleanly on the first run after approval.
    if (!bottle.wineDefinition) continue;

    const wdId = bottle.wineDefinition?._id?.toString();
    const profile = profileMap.get(`${wdId}:${bottle.vintage}`);
    const prevStatus = bottle.drinkWindowNotifiedStatus;

    // When the bottle's PERSONAL window governs the status (same precedence as
    // classifyMaturity), "ending soon" is measured against its drinkTo year
    // rather than the profile's peakUntil. Profile windows are resolved per
    // bottle so a relative (NV) peakUntil is a calendar year, not an offset.
    const personalGoverns = classifyPersonalWindow(bottle, currentYear) !== null;
    const windowEnd = personalGoverns
      ? (Number.isFinite(bottle.drinkTo) ? bottle.drinkTo : null)
      : resolveWindowForBottle(profile, bottle)?.peakUntil;

    // Determine notification type based on transition
    let notifType = null;

    if (maturityStatus === 'peak' && prevStatus !== 'peak' && prevStatus !== 'ending') {
      notifType = 'peak';
    } else if (maturityStatus === 'peak' && windowEnd && (windowEnd - currentYear) <= 1 && prevStatus !== 'ending') {
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

    transitionOps.push({
      updateOne: {
        filter: { _id: bottle._id },
        update: { $set: { drinkWindowNotifiedStatus: effectiveStatus, drinkWindowNotifiedAt: new Date() } },
      },
    });
  }

  if (seedOps.length > 0) {
    await Bottle.bulkWrite(seedOps, { ordered: false });
  }

  if (transitionOps.length > 0) {
    await Bottle.bulkWrite(transitionOps, { ordered: false });
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
    // Pass the 'drinkWindow' category so the push gate honours the
    // drinkWindow.push preference. Without it, createNotification falls back to
    // the permissive "any push toggle on" path and pushes even when the user
    // turned drinkWindow.push off.
    await createNotification(user._id, type, title, message, link, 'drinkWindow');
  }

  // The email is NOT sent here: maybeSendDrinkWindowEmail sends at most one a
  // week, built from every bottle notified since the last one.
  return uniqueAlerts.length;
}

/**
 * Alert once per opening when an open (Coravin'd / preserved) bottle reaches
 * the last day of its freshness window. The openBottleNotifiedAt marker
 * guarantees once-only delivery; opening again re-arms it.
 * Returns the number of notifications created.
 */
async function processOpenBottles(user) {
  const bottles = await Bottle.find({
    user: user._id,
    status: { $nin: NOT_IN_CELLAR_STATUSES },
    openedAt: { $ne: null },
    openBottleNotifiedAt: null,
  }).populate({ path: 'wineDefinition', select: 'name' }).lean();
  if (bottles.length === 0) return 0;

  const now = new Date();
  let count = 0;
  for (const bottle of bottles) {
    if (!shouldNotifyOpenBottle(bottle, now)) continue;

    const wineName = bottle.wineDefinition?.name || 'Unknown wine';
    const wine = bottle.vintage && bottle.vintage !== 'NV' ? `${wineName} ${bottle.vintage}` : wineName;
    const daysLeft = openBottleDaysLeft(bottle, now);
    const message = daysLeft <= 0
      ? `${wine} was opened and its freshness window has passed — drink it now if at all.`
      : `${wine} is open and its freshness window ends today — finish it while it's still good.`;

    await createNotification(
      user._id,
      'open_bottle_expiring',
      'Open bottle — drink it now',
      message,
      `/cellars/${bottle.cellar}/bottles/${bottle._id}`,
      'drinkWindow'
    );
    await Bottle.updateOne(
      { _id: bottle._id },
      { $set: { openBottleNotifiedAt: now } }
    );
    count++;
  }
  return count;
}

/**
 * Alert once when a bottle's reservedUntil year arrives (currentYear ≥
 * reservedUntil): the moment the bottle was being held FOR has come, so the
 * reservation stops being a reason to wait. The reservationNotifiedAt marker
 * guarantees once-only delivery; editing reservedUntil re-arms it
 * (bottleOps.updateBottleFields clears the marker on change).
 * Returns the number of notifications created.
 */
async function processReservations(user) {
  const currentYear = new Date().getFullYear();
  const bottles = await Bottle.find({
    user: user._id,
    status: { $nin: NOT_IN_CELLAR_STATUSES },
    // $lte on a number never matches null/missing (BSON type bracketing), so
    // bottles reserved without a year — or not reserved at all — are skipped.
    reservedUntil: { $lte: currentYear },
    reservationNotifiedAt: null,
  }).populate({ path: 'wineDefinition', select: 'name' }).lean();
  if (bottles.length === 0) return 0;

  const now = new Date();
  let count = 0;
  for (const bottle of bottles) {
    const wineName = bottle.wineDefinition?.name || 'Unknown wine';
    const wine = bottle.vintage && bottle.vintage !== 'NV' ? `${wineName} ${bottle.vintage}` : wineName;
    const who = (bottle.reservedFor || '').trim();
    const message = who
      ? `${wine} was reserved for ${who} until ${bottle.reservedUntil} — that year is here. Time to enjoy it (or update the reservation).`
      : `${wine} was reserved until ${bottle.reservedUntil} — that year is here. Time to enjoy it (or update the reservation).`;

    await createNotification(
      user._id,
      'reservation_due',
      'Reserved bottle — the year has arrived',
      message,
      `/cellars/${bottle.cellar}/bottles/${bottle._id}`,
      'drinkWindow'
    );
    await Bottle.updateOne(
      { _id: bottle._id },
      { $set: { reservationNotifiedAt: now } }
    );
    count++;
  }
  return count;
}

/**
 * Once the month a bottle on order was expected has passed, ask whether it
 * has arrived: ONE notification per cellar per run, however many bottles of
 * that cellar are late, linking to its on-order page where they are marked
 * as arrived. The arrivalNotifiedAt marker makes it once per expected month;
 * a new expected month re-arms it (bottleOps.updateBottleFields).
 * Returns the number of notifications created.
 */
async function processArrivals(user) {
  const now = new Date();
  // Coarse filter in the query (expected before this month began), exact
  // rule in isArrivalDue. Bottles on order with no date are never "late".
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const bottles = await Bottle.find({
    user: user._id,
    status: ORDERED_STATUS,
    expectedArrival: { $lt: monthStart },
    arrivalNotifiedAt: null,
  }).select('_id cellar vintage expectedArrival wineDefinition')
    .populate({ path: 'wineDefinition', select: 'name' }).lean();
  const due = bottles.filter((b) => isArrivalDue(b.expectedArrival, now));
  if (due.length === 0) return 0;

  // Only cellars that still exist and that this user owns: a bottle in a
  // deleted cellar is gone for the user, and a link to a cellar they cannot
  // open would dead-end.
  const liveCellars = new Set((await Cellar.distinct('_id', {
    _id: { $in: [...new Set(due.map((b) => String(b.cellar)))] }, user: user._id, deletedAt: null,
  })).map(String));

  const byCellar = new Map();
  for (const b of due) {
    const key = String(b.cellar);
    if (!liveCellars.has(key)) continue;
    if (!byCellar.has(key)) byCellar.set(key, []);
    byCellar.get(key).push(b);
  }

  let count = 0;
  for (const [cellarId, list] of byCellar) {
    const first = list[0];
    const wineName = first.wineDefinition?.name || 'A wine';
    const wine = first.vintage && first.vintage !== 'NV' ? `${wineName} ${first.vintage}` : wineName;
    const message = list.length === 1
      ? `${wine} was expected in ${formatArrivalMonth(first.expectedArrival)}. Has it arrived? Mark it as arrived, or update the expected month.`
      : `${list.length} bottles on order were expected by now, including ${wine}. Have they arrived? Mark them as arrived, or update the expected month.`;
    await createNotification(
      user._id,
      'order_arrival_due',
      list.length === 1 ? 'Has your order arrived?' : 'Have your orders arrived?',
      message,
      `/cellars/${cellarId}/on-order`,
      'drinkWindow'
    );
    await Bottle.updateMany(
      { _id: { $in: list.map((b) => b._id) } },
      { $set: { arrivalNotifiedAt: now } }
    );
    count++;
  }
  return count;
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

const EMAIL_GAP_MS = 7 * 24 * 60 * 60 * 1000;
// Stored bottle markers that a notification announced, and how the email
// words them: 'late' was announced as 'declining' (see processUser).
const EMAILED_STATUS = { peak: 'peak', ending: 'ending', late: 'declining', declining: 'declining' };
const EMAIL_ORDER = ['declining', 'ending', 'peak'];

/**
 * The drink-window email: at most one a week per member. It lists every wine
 * whose bottles were announced (in the bell) since the last email, or since the
 * account was created, but never further back than a week; bottles drunk or
 * moved out since are left out. Nothing is sent in an account's first week —
 * the new-member email (services/newMemberEmails) already says what is ready.
 *
 * @returns {Promise<number>} wines listed (0 = nothing sent)
 */
async function maybeSendDrinkWindowEmail(user, now = new Date()) {
  if (!shouldSendDigestEmail(user)) return 0;
  const last = user.drinkWindowEmailedAt || user.createdAt;
  if (last && now.getTime() - new Date(last).getTime() < EMAIL_GAP_MS) return 0;
  const since = new Date(Math.max(last ? new Date(last).getTime() : 0, now.getTime() - EMAIL_GAP_MS));

  const cellarIds = await Cellar.distinct('_id', { user: user._id, deletedAt: null });
  if (cellarIds.length === 0) return 0;
  const bottles = await Bottle.find({
    user: user._id,
    cellar: { $in: cellarIds },
    status: { $nin: NOT_IN_CELLAR_STATUSES },
    drinkWindowNotifiedAt: { $gt: since },
    drinkWindowNotifiedStatus: { $in: Object.keys(EMAILED_STATUS) },
  }).populate({ path: 'wineDefinition', select: 'name' }).lean();

  const lines = new Map();
  for (const b of bottles) {
    if (!b.wineDefinition) continue;
    const status = EMAILED_STATUS[b.drinkWindowNotifiedStatus];
    const key = `${b.wineDefinition._id}:${b.vintage}:${status}`;
    if (!lines.has(key)) lines.set(key, { name: b.wineDefinition.name || 'Unknown wine', vintage: b.vintage, status });
  }
  if (lines.size === 0) return 0;
  const list = [...lines.values()].sort((a, b) => EMAIL_ORDER.indexOf(a.status) - EMAIL_ORDER.indexOf(b.status));

  await sendDrinkWindowDigest(user.email, user.displayName || user.username, list, user._id);
  await User.updateOne({ _id: user._id }, { $set: { drinkWindowEmailedAt: now } });
  return list.length;
}

/**
 * Boot step (server.js), idempotent. New accounts get drink-window email and
 * push on by default; an older account with nothing stored for them read as
 * off. Store that off explicitly, so the new default can never switch an older
 * account on (a later non-lean save would write the default). A legacy scalar
 * `drinkWindow: false` is left alone — that account is off already. Later
 * boots find nothing: accounts store their values when they are created.
 *
 * @returns {Promise<number>} values stored
 */
async function storeDrinkWindowDefaultsOff() {
  let stored = 0;
  for (const leaf of ['email', 'push']) {
    const path = `preferences.notifications.drinkWindow.${leaf}`;
    const res = await User.updateMany(
      { [path]: { $exists: false }, 'preferences.notifications.drinkWindow': { $not: { $type: 'bool' } } },
      { $set: { [path]: false } },
    );
    stored += res.modifiedCount || 0;
  }
  return stored;
}

module.exports = {
  runDrinkWindowCheck, processUser, processOpenBottles, processReservations, processArrivals,
  shouldSendDigestEmail, maybeSendDrinkWindowEmail, storeDrinkWindowDefaultsOff, EMAIL_GAP_MS,
};
