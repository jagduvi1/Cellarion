/**
 * Inactive accounts. The Privacy Policy keeps account data "for as long as
 * your account is active" (section 7) and spells out what that means; this is
 * the job that makes it true.
 *
 * An account is inactive once nothing has used it — no sign-in, no session
 * renewal, no API token or AI connector (User.lastActiveAt, services/lastActive)
 * — for 24 months, or 12 months when it never held anything (no bottle, no
 * wishlist entry, no journal entry). Then, on a timeline stored on the account
 * (User.inactivityNotice):
 *   1. a first notice 30 days before the deletion date,
 *   2. a final notice 7 days before it,
 *   3. the account is erased on that date (services/userDeletionJob.eraseAccount).
 * Using the account at any point ends the timeline. The deletion date is never
 * sooner than 30 days after the first notice and 7 days after the final one,
 * whenever the job happens to run.
 *
 * Never inactive, whatever the date: demo accounts (they expire on their own),
 * staff (admin, sommelier, moderator), the system accounts (usernames starting
 * with "__"), an account already being deleted, a paying supporter, and the
 * owner of a shared cellar that one of its members still uses — erasing that
 * owner would erase the cellar under them.
 *
 * The notices are messages about the account itself, so they are emailed even
 * to someone who unsubscribed from all email (Privacy Policy, section 8). An
 * account with no confirmed address goes through the same timeline without
 * the emails; it is recorded as such (inactivityNotice.emailed).
 *
 * Off until an admin turns it on (SuperAdmin → Settings), and it does nothing
 * while email is not configured: nobody is deleted without being told.
 * Turning it on restarts every timeline. Runs daily (services/scheduler).
 */
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WishlistItem = require('../models/WishlistItem');
const JournalEntry = require('../models/JournalEntry');
const SiteConfig = require('../models/SiteConfig');
const { PLANS, PLAN_NAMES } = require('../config/plans');
const { updateSiteConfig } = require('../utils/siteConfig');
const { activeDay } = require('./lastActive');
// Read as a module, so whether email is configured is looked up at each run.
const mailgun = require('./mailgun');
const { eraseAccount } = require('./userDeletionJob');
const { logAudit } = require('./audit');

const CONFIG_KEY = 'inactiveAccounts';
const MONTHS_WITH_CONTENT = 24;
const MONTHS_EMPTY = 12;
const FIRST_NOTICE_DAYS = 30;
const FINAL_NOTICE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
const STAFF_ROLES = ['admin', 'somm', 'moderator'];
const PAID_PLANS = PLAN_NAMES.filter((p) => PLANS[p].price > 0);
const IN_CELLAR = ['active', 'ordered'];
// Bounded work per run; the next day's run picks up the rest.
const MAX_ACCOUNTS_PER_RUN = 500;
const MAX_DELETIONS_PER_RUN = 50;
const EMAIL_TIMEOUT_MS = 10_000;

/** `date` plus `months` calendar months (UTC). */
function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

const later = (a, b) => (a.getTime() >= b.getTime() ? a : b);

/** The admin switch: { enabled, since } (since = when it was last turned on). */
async function getSettings() {
  const doc = await SiteConfig.findOne({ key: CONFIG_KEY }).lean();
  const v = doc?.value || {};
  return { enabled: v.enabled === true, since: v.since ? new Date(v.since) : null };
}

/**
 * Turn the rule on or off. Turning it on clears every stored timeline, so each
 * account that is (or becomes) inactive gets a fresh first notice and the full
 * 30 days, however long the rule was off.
 */
async function setEnabled(enabled, updatedBy) {
  const current = await getSettings();
  if (current.enabled === enabled) return current;
  if (enabled) {
    await User.updateMany({ inactivityNotice: { $exists: true } }, { $unset: { inactivityNotice: '' } });
  }
  const value = { enabled, since: enabled ? new Date() : current.since };
  await updateSiteConfig(CONFIG_KEY, value, updatedBy);
  return value;
}

/** The day the account was last used; its creation day when never recorded. */
const lastUsed = (user) => (user.lastActiveAt ? new Date(user.lastActiveAt) : activeDay(user.createdAt));

/**
 * Whether a stored timeline still applies: started, and the account not used
 * since the day it was based on (inactivityNotice.unusedSince — compared as
 * days, the way lastActiveAt is stored, so a sign-in on the very day of the
 * first notice still ends it).
 */
function onTimeline(user) {
  const n = user.inactivityNotice;
  if (!n || !n.firstSentAt) return false;
  if (!user.lastActiveAt) return true;
  return !!n.unusedSince && new Date(user.lastActiveAt).getTime() <= new Date(n.unusedSince).getTime();
}

/** A paying supporter: a live Stripe subscription, or a paid plan that has not expired. */
function isPaying(user, now) {
  if (user.stripeSubscriptionId) return true;
  return PAID_PLANS.includes(user.plan) && (!user.planExpiresAt || new Date(user.planExpiresAt) > now);
}

/**
 * What the job does with one account today. Pure: `facts` is what factsFor
 * found ({ hasContent, sharedCellarInUse }). Returns
 *   { action: 'first' | 'final' | 'delete' | 'wait', months, due, deleteAfter }
 * or { action: 'skip:<reason>' }.
 */
function decide(user, facts, now) {
  if (user.isDemo) return { action: 'skip:demo' };
  if ((user.roles || []).some((r) => STAFF_ROLES.includes(r))) return { action: 'skip:staff' };
  if (typeof user.username === 'string' && user.username.startsWith('__')) return { action: 'skip:system' };
  if (user.deletionScheduledFor) return { action: 'skip:deleting' };
  if (isPaying(user, now)) return { action: 'skip:paying' };
  if (facts.sharedCellarInUse) return { action: 'skip:shared-cellar' };

  const months = facts.hasContent ? MONTHS_WITH_CONTENT : MONTHS_EMPTY;
  const due = addMonths(lastUsed(user), months);
  // A timeline only counts while the account is still as unused as when it
  // started; used since, it is over (the job also clears it, clearReturned).
  const notice = onTimeline(user) ? user.inactivityNotice : {};

  if (!notice.firstSentAt) {
    if (now.getTime() < due.getTime() - FIRST_NOTICE_DAYS * DAY) return { action: 'skip:active' };
    return { action: 'first', months, due, deleteAfter: later(due, new Date(now.getTime() + FIRST_NOTICE_DAYS * DAY)) };
  }
  const deleteAfter = new Date(notice.deleteAfter);
  if (!notice.finalSentAt) {
    if (now.getTime() < deleteAfter.getTime() - FINAL_NOTICE_DAYS * DAY) return { action: 'wait', months, due, deleteAfter };
    return { action: 'final', months, due, deleteAfter: later(deleteAfter, new Date(now.getTime() + FINAL_NOTICE_DAYS * DAY)) };
  }
  if (now.getTime() < deleteAfter.getTime()) return { action: 'wait', months, due, deleteAfter };
  return { action: 'delete', months, due, deleteAfter };
}

/**
 * What decide() needs from outside the account row: whether it holds anything
 * (which period applies), and whether a cellar it owns is shared with someone
 * who still uses Cellarion (within the owner's own period).
 */
async function factsFor(user, now) {
  const [bottle, wish, journal] = await Promise.all([
    Bottle.exists({ user: user._id }),
    WishlistItem.exists({ user: user._id }),
    JournalEntry.exists({ user: user._id }),
  ]);
  const hasContent = !!(bottle || wish || journal);
  const shared = await Cellar.find({ user: user._id, deletedAt: null, 'members.0': { $exists: true } })
    .select('members.user').lean();
  const memberIds = shared.flatMap((c) => (c.members || []).map((m) => m.user)).filter(Boolean);
  let sharedCellarInUse = false;
  if (memberIds.length) {
    const cutoff = addMonths(now, -(hasContent ? MONTHS_WITH_CONTENT : MONTHS_EMPTY));
    sharedCellarInUse = !!(await User.exists({ _id: { $in: memberIds }, lastActiveAt: { $gte: cutoff } }));
  }
  return { hasContent, sharedCellarInUse };
}

const ACCOUNT_FIELDS = '_id username displayName email emailVerified roles isDemo deletionScheduledFor plan planExpiresAt stripeSubscriptionId stripeCustomerId createdAt lastActiveAt inactivityNotice';

/**
 * Accounts that could be due for something today: unused for at least the
 * shorter period minus the first-notice lead, or already on a timeline.
 * Accounts that can never be inactive are left out of the query itself.
 */
function candidateQuery(now) {
  const earliest = new Date(addMonths(now, -MONTHS_EMPTY).getTime() + FIRST_NOTICE_DAYS * DAY);
  return {
    isDemo: { $ne: true },
    deletionScheduledFor: null,
    roles: { $nin: STAFF_ROLES },
    username: { $not: /^__/ },
    $or: [
      { lastActiveAt: { $lte: earliest } },
      { lastActiveAt: null, createdAt: { $lte: earliest } },
      { 'inactivityNotice.firstSentAt': { $ne: null } },
    ],
  };
}

/**
 * A timeline ends the moment the account is used again: lastActiveAt has moved
 * past the day the timeline was based on (a Date is greater than null, so an
 * account first seen since then counts as used too).
 */
async function clearReturned() {
  const r = await User.updateMany(
    { 'inactivityNotice.firstSentAt': { $ne: null }, $expr: { $gt: ['$lastActiveAt', '$inactivityNotice.unusedSince'] } },
    { $unset: { inactivityNotice: '' } },
  );
  return r?.modifiedCount || 0;
}

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref?.()),
]);

/**
 * Send one notice. The stamp is claimed first, guarded on the account still
 * being unused (lastActiveAt unchanged since the read): a sign-in a moment
 * ago wins. A send that fails after the claim is not retried — the deletion
 * date it announced stands, and the final notice still follows.
 */
async function sendNotice(user, d, now) {
  const final = d.action === 'final';
  const deliverable = !!(user.email && user.emailVerified);
  const unusedSince = user.lastActiveAt ? new Date(user.lastActiveAt) : null;
  // Claimed only while lastActiveAt is what was read: used a moment ago, no notice.
  const guard = { _id: user._id, lastActiveAt: unusedSince };
  const update = final
    ? { $set: { 'inactivityNotice.finalSentAt': now, 'inactivityNotice.deleteAfter': d.deleteAfter } }
    : { $set: { inactivityNotice: { firstSentAt: now, finalSentAt: null, deleteAfter: d.deleteAfter, emailed: deliverable, unusedSince } } };
  // A first notice may replace a timeline that has ended (used since); null
  // matches a missing stamp as well.
  const filter = final
    ? { ...guard, 'inactivityNotice.firstSentAt': { $ne: null }, 'inactivityNotice.finalSentAt': null }
    : (user.inactivityNotice?.firstSentAt
      ? { ...guard, 'inactivityNotice.firstSentAt': user.inactivityNotice.firstSentAt }
      : { ...guard, 'inactivityNotice.firstSentAt': null });
  const claimed = await User.findOneAndUpdate(filter, update).select('_id');
  if (!claimed) return false;

  let emailed = false;
  if (deliverable) {
    try {
      const bottles = await Bottle.countDocuments({ user: user._id, status: { $in: IN_CELLAR } });
      await withTimeout(mailgun.sendInactivityNoticeEmail(user.email, user.displayName || user.username || 'there', {
        final, deleteAfter: d.deleteAfter, lastActiveAt: lastUsed(user), months: d.months, bottles,
      }), EMAIL_TIMEOUT_MS);
      emailed = true;
    } catch (err) {
      console.error(`[inactiveAccounts] ${d.action} notice FAILED for user ${user._id} — stamp is set, will NOT retry:`, err.message);
    }
  }
  if (!final && !emailed && deliverable) {
    User.updateOne({ _id: user._id }, { $set: { 'inactivityNotice.emailed': false } }).catch(() => {});
  }
  logAudit(null, 'user.inactivity_notice', { type: 'user', id: user._id }, {
    notice: d.action, deleteAfter: d.deleteAfter, months: d.months, emailed,
  });
  return true;
}

/**
 * Erase one account whose date has come. Everything is read and decided again
 * from a fresh copy first, so an account used, upgraded or shared since the
 * run started is left alone.
 */
async function deleteOne(userId, now) {
  const fresh = await User.findById(userId).select(ACCOUNT_FIELDS).lean();
  if (!fresh) return false;
  const d = decide(fresh, await factsFor(fresh, now), now);
  if (d.action !== 'delete') return false;
  await eraseAccount(fresh);
  logAudit(null, 'user.inactivity_deleted', { type: 'user', id: fresh._id }, {
    months: d.months, lastActiveAt: lastUsed(fresh), deleteAfter: d.deleteAfter,
  });
  return true;
}

/**
 * Today's decisions without acting on them (SuperAdmin shows these before the
 * rule is turned on, and the job uses the same walk).
 */
async function plan({ now = new Date() } = {}) {
  const users = await User.find(candidateQuery(now)).select(ACCOUNT_FIELDS)
    .sort({ lastActiveAt: 1 }).limit(MAX_ACCOUNTS_PER_RUN).lean();
  const decisions = [];
  for (const user of users) {
    decisions.push({ user, decision: decide(user, await factsFor(user, now), now) });
  }
  return decisions;
}

/** Counts by action, for the admin panel. */
async function preview({ now = new Date() } = {}) {
  const counts = {};
  for (const { decision } of await plan({ now })) counts[decision.action] = (counts[decision.action] || 0) + 1;
  return counts;
}

/** The daily job. Never throws past the scheduler's own catch. */
async function runInactiveAccounts({ now = new Date() } = {}) {
  if (!mailgun.EMAIL_VERIFICATION_ENABLED) return { skipped: 'email-not-configured' };
  const { enabled } = await getSettings();
  if (!enabled) return { skipped: 'off' };

  const result = { cleared: await clearReturned(), first: 0, final: 0, deleted: 0, failed: 0 };
  for (const { user, decision } of await plan({ now })) {
    try {
      // Exempt now (paying, a shared cellar in use, …) while on a timeline: the
      // timeline ends, so an old notice can never lead to a deletion later.
      if (decision.action.startsWith('skip:') && user.inactivityNotice?.firstSentAt) {
        await User.updateOne({ _id: user._id }, { $unset: { inactivityNotice: '' } });
        result.cleared += 1;
        continue;
      }
      if (decision.action === 'first' || decision.action === 'final') {
        if (await sendNotice(user, decision, now)) result[decision.action] += 1;
      } else if (decision.action === 'delete' && result.deleted < MAX_DELETIONS_PER_RUN) {
        if (await deleteOne(user._id, now)) result.deleted += 1;
      }
    } catch (err) {
      result.failed += 1;
      console.error(`[inactiveAccounts] ${decision.action} failed for user ${user._id}:`, err.message);
    }
  }
  return result;
}

module.exports = {
  runInactiveAccounts,
  preview,
  decide,
  factsFor,
  candidateQuery,
  getSettings,
  setEnabled,
  addMonths,
  CONFIG_KEY,
  MONTHS_WITH_CONTENT,
  MONTHS_EMPTY,
  FIRST_NOTICE_DAYS,
  FINAL_NOTICE_DAYS,
};
