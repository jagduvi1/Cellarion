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
 * Nobody is counted as unused from before the day this install started
 * recording use (lastActive.getTrackingSince): older history is mostly gone
 * (sessions last 30 days, the activity log 90), and a missing trace is not
 * proof of absence. So no account can reach a notice before that day plus the
 * period, whatever its creation date or backfilled lastActiveAt says.
 *
 * Never inactive, whatever the date: demo accounts (they expire on their own),
 * staff (admin, sommelier, moderator), the system accounts (usernames starting
 * with "__"), an account already being deleted, a paying supporter, and the
 * owner of a shared cellar that one of its members still uses — erasing that
 * owner would erase the cellar under them.
 *
 * The notices are messages about the account itself, so they are emailed even
 * to someone who unsubscribed from all email (Privacy Policy, section 8). A
 * notice counts only once it was handed to the mail service: a failed send is
 * rolled back and tried again the next day, and no account is erased in a run
 * in which a notice failed. An account with no confirmed address (it cannot be
 * signed in to) goes through the timeline without the emails, as the policy
 * says (inactivityNotice.emailed false).
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
const { activeDay, getTrackingSince } = require('./lastActive');
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
// Bounded work per run, per kind of step. Each query selects only accounts
// with a step due today, so the rest is reached on later days.
const MAX_PER_STEP = 500;
// Accounts in the 12-month band are read in a wider window and narrowed in
// bulk to the empty ones before anything else is done with them.
const EMPTY_BAND_WINDOW = 5000;
const MAX_DELETIONS_PER_RUN = 50;
const EMAIL_TIMEOUT_MS = 10_000;
// A claim older than this was left by an earlier run that did not finish
// (runs are daily, a send takes seconds): take it over. A claim to send a
// notice is retried within the hour; one to erase, at the next day's run.
const STALE_SEND_CLAIM_MS = 60 * 60 * 1000;
const STALE_ERASE_CLAIM_MS = 12 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

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
  previewCache = null;
  return value;
}

/**
 * The day from which the account counts as unused: its last recorded day of
 * use (its creation day when none was recorded), but never earlier than the
 * day this install started recording use.
 */
function unusedFrom(user, trackedSince) {
  const recorded = user.lastActiveAt ? new Date(user.lastActiveAt) : activeDay(user.createdAt);
  return trackedSince ? later(recorded, new Date(trackedSince)) : recorded;
}

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
 * found ({ hasContent, sharedCellarInUse }); `trackedSince` the day this
 * install started recording use (getTrackingSince). Returns
 *   { action: 'first' | 'final' | 'delete' | 'wait', months, due, deleteAfter, unusedFrom }
 * or { action: 'skip:<reason>' }.
 */
function decide(user, facts, now, trackedSince = null) {
  if (user.isDemo) return { action: 'skip:demo' };
  if ((user.roles || []).some((r) => STAFF_ROLES.includes(r))) return { action: 'skip:staff' };
  if (typeof user.username === 'string' && user.username.startsWith('__')) return { action: 'skip:system' };
  if (user.deletionScheduledFor) return { action: 'skip:deleting' };
  if (isPaying(user, now)) return { action: 'skip:paying' };
  if (facts.sharedCellarInUse) return { action: 'skip:shared-cellar' };

  const months = facts.hasContent ? MONTHS_WITH_CONTENT : MONTHS_EMPTY;
  const from = unusedFrom(user, trackedSince);
  const due = addMonths(from, months);
  const base = { months, due, unusedFrom: from };
  // A timeline only counts while the account is still as unused as when it
  // started; used since, it is over (the job also clears it, clearReturned).
  const notice = onTimeline(user) ? user.inactivityNotice : {};

  if (!notice.firstSentAt) {
    if (now.getTime() < due.getTime() - FIRST_NOTICE_DAYS * DAY) return { action: 'skip:active' };
    return { action: 'first', ...base, deleteAfter: later(due, new Date(now.getTime() + FIRST_NOTICE_DAYS * DAY)) };
  }
  const deleteAfter = new Date(notice.deleteAfter);
  // The stored date already lies on or after `due`; checked again so that no
  // later step can come before the account has been unused for the period.
  if (now.getTime() < due.getTime() - FINAL_NOTICE_DAYS * DAY) return { action: 'wait', ...base, deleteAfter };
  if (!notice.finalSentAt) {
    if (now.getTime() < deleteAfter.getTime() - FINAL_NOTICE_DAYS * DAY) return { action: 'wait', ...base, deleteAfter };
    return { action: 'final', ...base, deleteAfter: later(deleteAfter, new Date(now.getTime() + FINAL_NOTICE_DAYS * DAY)) };
  }
  if (now.getTime() < deleteAfter.getTime() || now.getTime() < due.getTime()) return { action: 'wait', ...base, deleteAfter };
  return { action: 'delete', ...base, deleteAfter };
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

// Accounts that can never be inactive are left out of every query (the
// owner of a shared cellar in use needs a lookup, so decide() handles it).
const base = (now) => ({
  isDemo: { $ne: true },
  deletionScheduledFor: null,
  roles: { $nin: STAFF_ROLES },
  username: { $not: /^__/ },
  stripeSubscriptionId: null,
  $nor: [{ plan: { $in: PAID_PLANS }, $or: [{ planExpiresAt: null }, { planExpiresAt: { $gt: now } }] }],
});

/** Unused (by lastActiveAt, or creation when none) on or before `cutoff`. */
const unusedBy = (cutoff) => ({
  $or: [{ lastActiveAt: { $lte: cutoff } }, { lastActiveAt: null, createdAt: { $lte: cutoff } }],
});

/**
 * The three kinds of account with a step that may be due today, each its own
 * bounded query, so none of them can keep another out:
 *   - on a timeline whose next notice or erasure is due;
 *   - not on one, and unused long enough for a first notice under 24 months;
 *   - not on one, unused long enough under 12 months, and empty (narrowed in
 *     bulk from a wider window, so accounts with content waiting for their 24
 *     months never fill the step).
 * No first notice is possible before the tracking start plus the period less
 * the notice lead, so those two queries are skipped until then.
 */
async function candidates(now, trackedSince) {
  const seen = new Map();
  const add = (rows) => { for (const r of rows) if (!seen.has(String(r._id))) seen.set(String(r._id), r); };

  add(await User.find({
    ...base(now),
    'inactivityNotice.firstSentAt': { $ne: null },
    $or: [
      { 'inactivityNotice.finalSentAt': null, 'inactivityNotice.deleteAfter': { $lte: new Date(now.getTime() + FINAL_NOTICE_DAYS * DAY) } },
      { 'inactivityNotice.finalSentAt': { $ne: null }, 'inactivityNotice.deleteAfter': { $lte: now } },
    ],
  }).select(ACCOUNT_FIELDS).sort({ 'inactivityNotice.deleteAfter': 1 }).limit(MAX_PER_STEP).lean());

  const lead = FIRST_NOTICE_DAYS * DAY;
  const cutoff24 = new Date(addMonths(now, -MONTHS_WITH_CONTENT).getTime() + lead);
  const cutoff12 = new Date(addMonths(now, -MONTHS_EMPTY).getTime() + lead);
  const tracked = trackedSince ? new Date(trackedSince).getTime() : 0;
  const notOnTimeline = { 'inactivityNotice.firstSentAt': null };

  if (tracked <= cutoff24.getTime()) {
    add(await User.find({ ...base(now), ...notOnTimeline, ...unusedBy(cutoff24) })
      .select(ACCOUNT_FIELDS).sort({ lastActiveAt: 1, createdAt: 1 }).limit(MAX_PER_STEP).lean());
  }
  if (tracked <= cutoff12.getTime()) {
    const band = await User.find({ ...base(now), ...notOnTimeline, ...unusedBy(cutoff12) })
      .select('_id').sort({ lastActiveAt: 1, createdAt: 1 }).limit(EMPTY_BAND_WINDOW).lean();
    const ids = band.map((u) => u._id).filter((id) => !seen.has(String(id)));
    if (ids.length) {
      const holders = new Set((await Promise.all([
        Bottle.distinct('user', { user: { $in: ids } }),
        WishlistItem.distinct('user', { user: { $in: ids } }),
        JournalEntry.distinct('user', { user: { $in: ids } }),
      ])).flat().map(String));
      const empty = ids.filter((id) => !holders.has(String(id))).slice(0, MAX_PER_STEP);
      if (empty.length) add(await User.find({ _id: { $in: empty } }).select(ACCOUNT_FIELDS).lean());
    }
  }
  return [...seen.values()];
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

function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Send one notice, in two steps, so a notice counts only once the mail service
 * accepted it. First a claim (sendingAt / finalSendingAt), guarded on the
 * account still being unused (lastActiveAt unchanged since the read): a
 * sign-in a moment ago wins, and two processes never send the same notice.
 * Then the email; only after it was accepted are firstSentAt / finalSentAt and
 * the date written. A failed send releases the claim, so the notice is tried
 * again the next day and its date counts from then. A claim left behind by a
 * run that stopped half-way (a deploy, a lost connection) is taken over after
 * an hour, so the notice is sent, not skipped. A send that timed out may still
 * have arrived; a second copy is the lesser harm.
 * Returns 'sent' | 'lost' (someone else has it, or the account was used)
 * | 'failed'.
 */
async function sendNotice(user, d, now) {
  const final = d.action === 'final';
  const deliverable = !!(user.email && user.emailVerified);
  const unusedSince = user.lastActiveAt ? new Date(user.lastActiveAt) : null;
  const stale = new Date(now.getTime() - STALE_SEND_CLAIM_MS);
  const guard = { _id: user._id, lastActiveAt: unusedSince };
  const claimField = final ? 'inactivityNotice.finalSendingAt' : 'inactivityNotice.sendingAt';
  const free = { $or: [{ [claimField]: null }, { [claimField]: { $lte: stale } }] };
  let filter;
  let update;
  if (final) {
    filter = { ...guard, ...free, 'inactivityNotice.firstSentAt': { $ne: null }, 'inactivityNotice.finalSentAt': null };
    update = { $set: { 'inactivityNotice.finalSendingAt': now } };
  } else {
    // A first notice may replace a timeline that has ended (used since); null
    // matches a missing stamp as well.
    filter = user.inactivityNotice?.firstSentAt
      ? { ...guard, 'inactivityNotice.firstSentAt': user.inactivityNotice.firstSentAt }
      : { ...guard, ...free, 'inactivityNotice.firstSentAt': null };
    update = { $set: { inactivityNotice: {
      firstSentAt: null, finalSentAt: null, deleteAfter: d.deleteAfter, emailed: false, unusedSince,
      sendingAt: now, finalSendingAt: null, erasingAt: null,
    } } };
  }
  const claimed = await User.findOneAndUpdate(filter, update).select('_id');
  if (!claimed) return 'lost';

  if (deliverable) {
    try {
      const bottles = await Bottle.countDocuments({ user: user._id, status: { $in: IN_CELLAR } });
      await withTimeout(mailgun.sendInactivityNoticeEmail(user.email, user.displayName || user.username || 'there', {
        final, deleteAfter: d.deleteAfter, lastActiveAt: d.unusedFrom, months: d.months, bottles,
      }), EMAIL_TIMEOUT_MS);
    } catch (err) {
      console.error(`[inactiveAccounts] ${d.action} notice FAILED for user ${user._id} — not counted, tried again tomorrow:`, err.message);
      // Release the claim (a claim this fails to release goes stale in an hour).
      await User.updateOne({ _id: user._id, [claimField]: now }, final
        ? { $set: { 'inactivityNotice.finalSendingAt': null } }
        : { $unset: { inactivityNotice: '' } })
        .catch((e) => console.error(`[inactiveAccounts] releasing the ${d.action} claim for user ${user._id} failed:`, e.message));
      return 'failed';
    }
  }
  // Accepted (or nobody to email): now the notice counts.
  await User.updateOne({ _id: user._id, [claimField]: now }, final
    ? { $set: { 'inactivityNotice.finalSentAt': now, 'inactivityNotice.deleteAfter': d.deleteAfter, 'inactivityNotice.finalSendingAt': null } }
    : { $set: { 'inactivityNotice.firstSentAt': now, 'inactivityNotice.emailed': deliverable, 'inactivityNotice.sendingAt': null } });
  logAudit(null, 'user.inactivity_notice', { type: 'user', id: user._id }, {
    notice: d.action, deleteAfter: d.deleteAfter, months: d.months, emailed: deliverable,
  });
  return 'sent';
}

/**
 * Erase one account whose date has come. It is read and decided again from a
 * fresh copy first, so an account used, upgraded or shared since the run
 * started is left alone; then claimed (guarded on that same copy), so two
 * processes running the job at once erase it once.
 */
async function deleteOne(userId, now, trackedSince) {
  const fresh = await User.findById(userId).select(ACCOUNT_FIELDS).lean();
  if (!fresh) return false;
  const d = decide(fresh, await factsFor(fresh, now), now, trackedSince);
  if (d.action !== 'delete') return false;
  const claimed = await User.findOneAndUpdate(
    {
      _id: fresh._id,
      lastActiveAt: fresh.lastActiveAt ?? null,
      'inactivityNotice.finalSentAt': { $ne: null },
      $or: [
        { 'inactivityNotice.erasingAt': null },
        { 'inactivityNotice.erasingAt': { $lte: new Date(now.getTime() - STALE_ERASE_CLAIM_MS) } },
      ],
    },
    { $set: { 'inactivityNotice.erasingAt': now } },
  ).select('_id');
  if (!claimed) return false;
  try {
    await eraseAccount(fresh);
  } catch (err) {
    // Let the next run retry it rather than wait out the stale-claim window.
    await User.updateOne({ _id: fresh._id, 'inactivityNotice.erasingAt': now }, { $set: { 'inactivityNotice.erasingAt': null } })
      .catch(() => {});
    throw err;
  }
  logAudit(null, 'user.inactivity_deleted', { type: 'user', id: fresh._id }, {
    months: d.months, lastActiveAt: d.unusedFrom, deleteAfter: d.deleteAfter,
  });
  return true;
}

/** Today's decisions without acting on them; the job and the admin preview share it. */
async function plan({ now = new Date(), trackedSince } = {}) {
  const since = trackedSince || await getTrackingSince(now);
  const decisions = [];
  for (const user of await candidates(now, since)) {
    decisions.push({ user, decision: decide(user, await factsFor(user, now), now, since) });
  }
  return { trackedSince: since, decisions };
}

// The admin panel reads the preview on every load; it walks up to a few
// hundred accounts with several queries each, so it is kept for ten minutes.
let previewCache = null;

/** Counts by action, for the admin panel, plus the tracking start. */
async function preview({ now = new Date(), fresh = false } = {}) {
  if (!fresh && previewCache && now.getTime() - previewCache.at < PREVIEW_TTL_MS) return previewCache.value;
  const { trackedSince, decisions } = await plan({ now });
  const counts = {};
  for (const { decision } of decisions) counts[decision.action] = (counts[decision.action] || 0) + 1;
  const value = { counts, trackedSince };
  previewCache = { at: now.getTime(), value };
  return value;
}

/** The daily job. Never throws past the scheduler's own catch. */
async function runInactiveAccounts({ now = new Date() } = {}) {
  if (!mailgun.EMAIL_VERIFICATION_ENABLED) return { skipped: 'email-not-configured' };
  const { enabled } = await getSettings();
  if (!enabled) return { skipped: 'off' };

  const result = { cleared: await clearReturned(), first: 0, final: 0, deleted: 0, failed: 0 };
  const { trackedSince, decisions } = await plan({ now });
  const due = [];
  for (const { user, decision } of decisions) {
    try {
      // Exempt now (paying, a shared cellar in use, …) while on a timeline: the
      // timeline ends, so an old notice can never lead to a deletion later.
      if (decision.action.startsWith('skip:') && user.inactivityNotice?.firstSentAt) {
        await User.updateOne({ _id: user._id }, { $unset: { inactivityNotice: '' } });
        result.cleared += 1;
      } else if (decision.action === 'first' || decision.action === 'final') {
        const r = await sendNotice(user, decision, now);
        if (r === 'sent') result[decision.action] += 1;
        else if (r === 'failed') result.failed += 1;
      } else if (decision.action === 'delete') {
        due.push(user._id);
      }
    } catch (err) {
      result.failed += 1;
      console.error(`[inactiveAccounts] ${decision.action} failed for user ${user._id}:`, err.message);
    }
  }
  // Erasures last, and none in a run in which a notice could not be sent:
  // whatever stopped that email may have stopped the earlier ones too.
  if (result.failed === 0) {
    for (const id of due.slice(0, MAX_DELETIONS_PER_RUN)) {
      try {
        if (await deleteOne(id, now, trackedSince)) result.deleted += 1;
      } catch (err) {
        result.failed += 1;
        console.error(`[inactiveAccounts] erase failed for user ${id}:`, err.message);
      }
    }
  } else if (due.length) {
    result.deletionsHeld = due.length;
  }
  if (result.first || result.final || result.deleted) previewCache = null;
  return result;
}

module.exports = {
  runInactiveAccounts,
  preview,
  plan,
  decide,
  factsFor,
  candidates,
  getSettings,
  setEnabled,
  addMonths,
  unusedFrom,
  CONFIG_KEY,
  MONTHS_WITH_CONTENT,
  MONTHS_EMPTY,
  FIRST_NOTICE_DAYS,
  FINAL_NOTICE_DAYS,
};
