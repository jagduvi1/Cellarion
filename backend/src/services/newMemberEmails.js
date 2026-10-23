/**
 * New-member emails. Two days after someone joins, if they have not come back
 * since their first day, they get ONE email, once, ever:
 *   - 'cellar': they added bottles. What is in the cellar, what is ready to
 *     drink now, and a link back. People who come back on a second day in their
 *     first week stay several times as often as people who don't.
 *   - 'empty': no bottles. The quickest way to add the first one, and an
 *     equally plain "Not for you? Delete your account" link
 *     (utils/accountDeletionLink).
 * Nobody else gets one: not demo or admin accounts, an unverified address,
 * someone who unsubscribed from all email or whose account is being deleted,
 * nor someone with no bottles of their own who is a member of another
 * person's cellar (a household member, who uses that cellar). These are
 * service emails about the person's own account, so they carry no supporter
 * or donation content.
 *
 * Off until an admin turns it on (SuperAdmin → Settings). Only accounts created
 * after it was turned on are considered, so nobody who joined earlier gets one
 * out of the blue. Runs daily at 17:00 UTC (services/scheduler).
 * scripts/new-member-emails-backtest.js runs the same selection over past days.
 */
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const AuditLog = require('../models/AuditLog');
const SiteConfig = require('../models/SiteConfig');
// cellarSummary populates bottles' wines: register the model here, so the
// summary also works outside the server (a script), not only where a route
// happened to load it first.
require('../models/WineDefinition');
const { updateSiteConfig } = require('../utils/siteConfig');
const { buildProfileMap, classifyMaturity } = require('../utils/maturityUtils');
const { sendNewMemberCellarEmail, sendNewMemberEmptyEmail, EMAIL_VERIFICATION_ENABLED } = require('./mailgun');
const { logAudit } = require('./audit');

const CONFIG_KEY = 'newMemberEmails';
const DAY = 24 * 60 * 60 * 1000;
// Rows a machine writes for a person (an integration polling, a token refresh)
// are not the person coming back.
const MACHINE_ACTIONS = ['token.used', 'oauth.token_refreshed', 'bridge.key.used'];
// Sign-ins are logged about the account (resource), not by it (actor).
const SIGN_IN_ACTIONS = ['auth.login.success', 'auth.oauth.success'];
const IN_CELLAR = ['active', 'ordered'];
// What "ready to drink now" lists, most urgent first.
const READY_ORDER = ['declining', 'late', 'peak'];
const READY_LIST_MAX = 3;

const startOfUtcDay = (t) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** The admin switch: { enabled, since } (since = when it was last turned on). */
async function getSettings() {
  const doc = await SiteConfig.findOne({ key: CONFIG_KEY }).lean();
  const v = doc?.value || {};
  return { enabled: v.enabled === true, since: v.since ? new Date(v.since) : null };
}

/**
 * Turn the emails on or off. Turning them on starts a new `since`, so accounts
 * created while they were off never get one.
 */
async function setEnabled(enabled, updatedBy) {
  const current = await getSettings();
  if (current.enabled === enabled) return current;
  const value = { enabled, since: enabled ? new Date() : current.since };
  await updateSiteConfig(CONFIG_KEY, value, updatedBy);
  return value;
}

/**
 * Which email (if any) a new account gets. Pure: `facts` is what factsFor
 * found. Returns 'cellar' | 'empty', or 'skip:<reason>'.
 */
function chooseEmail(user, facts, { ignoreSent = false } = {}) {
  if (!ignoreSent && user.newMemberEmailSentAt) return 'skip:sent';
  if (user.isDemo) return 'skip:demo';
  if ((user.roles || []).includes('admin')) return 'skip:admin';
  if (user.deletionScheduledFor) return 'skip:deleting';
  if (!user.email || !user.emailVerified) return 'skip:unverified';
  if (user.emailOptOutAt) return 'skip:unsubscribed';
  if (facts.cameBack) return 'skip:cameBack';
  if (facts.bottles > 0) return 'cellar';
  if (facts.member) return 'skip:member';
  return 'empty';
}

/**
 * What the choice depends on, as of `runAt`. "Came back" means any activity on
 * a later UTC day than the sign-up day: a change they made, a sign-in, or (live
 * only) a device session used since — that also catches someone who only
 * looked. A session keeps only its latest use, so a backtest of a past day
 * cannot read it and relies on the audit log alone.
 */
async function factsFor(user, runAt, { live }) {
  const nextDay = new Date(startOfUtcDay(user.createdAt).getTime() + DAY);
  const [activity, cellarIds, member] = await Promise.all([
    AuditLog.exists({
      timestamp: { $gte: nextDay, $lt: runAt },
      $or: [
        { 'actor.userId': user._id, action: { $nin: MACHINE_ACTIONS } },
        { 'resource.id': user._id, action: { $in: SIGN_IN_ACTIONS } },
      ],
    }),
    Cellar.distinct('_id', { user: user._id, deletedAt: null }),
    Cellar.exists({ 'members.user': user._id, deletedAt: null }),
  ]);
  const sessionUsed = live && (user.sessions || []).some((s) => s.lastUsedAt && new Date(s.lastUsedAt) >= nextDay);
  const bottles = cellarIds.length
    ? await Bottle.countDocuments({
      cellar: { $in: cellarIds },
      createdAt: { $lt: runAt },
      // Live: what is in the cellar now. A backtest counts what was added by
      // then, whatever happened to it since.
      ...(live ? { status: { $in: IN_CELLAR } } : {}),
    })
    : 0;
  return { cameBack: !!activity || sessionUsed, bottles, member: !!member };
}

/**
 * Accounts that signed up two or three UTC days before `runAt` (and not before
 * `since`), each with its facts and choice. `live: false` is the backtest
 * mode: sent stamps and sessions are ignored and bottles are counted as of
 * `runAt`.
 */
async function findCandidates({ runAt = new Date(), since = null, live = true } = {}) {
  const today = startOfUtcDay(runAt).getTime();
  let from = new Date(today - 3 * DAY);
  const to = new Date(today - DAY);
  if (since && since > from) from = since;
  if (from >= to) return [];

  const users = await User.find({
    createdAt: { $gte: from, $lt: to },
    ...(live ? { newMemberEmailSentAt: null } : {}),
  })
    .select('email emailVerified emailOptOutAt isDemo roles deletionScheduledFor createdAt username displayName sessions.lastUsedAt newMemberEmailSentAt')
    .lean();

  const candidates = [];
  for (const user of users) {
    const facts = await factsFor(user, runAt, { live });
    candidates.push({ user, facts, choice: chooseEmail(user, facts, { ignoreSent: !live }) });
  }
  return candidates;
}

const wineName = (wd) => {
  const name = String(wd?.name || '').trim();
  const producer = String(wd?.producer || '').trim();
  if (!producer || name.toLowerCase().startsWith(producer.toLowerCase())) return name || producer;
  return `${producer} ${name}`;
};

/**
 * What the 'cellar' email shows: how many bottles, how many of them (and of
 * how many wines) are ready to drink now, up to three of those wines (most
 * urgent first, one line per wine and vintage), and the cellar the button
 * opens (the one holding the most bottles).
 */
async function cellarSummary(userId) {
  const cellarIds = await Cellar.distinct('_id', { user: userId, deletedAt: null });
  const bottles = await Bottle.find({ cellar: { $in: cellarIds }, status: { $in: IN_CELLAR } })
    .select('cellar wineDefinition vintage status drinkFrom drinkTo purchaseDate createdAt')
    .populate({ path: 'wineDefinition', select: 'name producer' })
    .lean();

  const perCellar = new Map();
  for (const b of bottles) perCellar.set(String(b.cellar), (perCellar.get(String(b.cellar)) || 0) + 1);
  const mainCellarId = [...perCellar.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const active = bottles.filter((b) => b.status === 'active');
  const profileMap = await buildProfileMap(active);
  const ready = new Map();
  for (const b of active) {
    const status = classifyMaturity(b, profileMap);
    if (!READY_ORDER.includes(status) || !b.wineDefinition) continue;
    const key = `${b.wineDefinition._id}:${b.vintage}`;
    const line = ready.get(key) || { wine: wineName(b.wineDefinition), vintage: b.vintage || null, count: 0, status };
    line.count += 1;
    ready.set(key, line);
  }
  const readyList = [...ready.values()]
    .sort((a, b) => READY_ORDER.indexOf(a.status) - READY_ORDER.indexOf(b.status) || b.count - a.count)
    .slice(0, READY_LIST_MAX)
    .map(({ wine, vintage, count }) => ({ wine, vintage, count }));

  return {
    bottles: bottles.length,
    readyCount: [...ready.values()].reduce((n, l) => n + l.count, 0),
    readyWines: ready.size,
    ready: readyList,
    cellarPath: mainCellarId ? `/cellars/${mainCellarId}` : '/cellars',
  };
}

/**
 * Send one email to one candidate. The stamp is claimed before the send, as
 * the supporter thank-you does: a send that fails after the claim is not
 * retried, because two of these would be worse than none.
 */
async function sendOne(user, kind, now) {
  const summary = kind === 'cellar' ? await cellarSummary(user._id) : null;
  const claimed = await User.findOneAndUpdate(
    { _id: user._id, newMemberEmailSentAt: null },
    { $set: { newMemberEmailSentAt: now, newMemberEmailKind: kind } },
  ).select('_id');
  if (!claimed) return false;
  try {
    const name = user.displayName || user.username || 'there';
    if (kind === 'cellar') {
      await sendNewMemberCellarEmail(user.email, name, String(user._id), summary);
    } else {
      await sendNewMemberEmptyEmail(user.email, name, String(user._id));
    }
    logAudit(null, 'user.new_member_email_sent', { type: 'user', id: user._id }, { kind });
    return true;
  } catch (err) {
    console.error(`[newMemberEmails] send FAILED for user ${user._id} (${kind}) — stamp is set, will NOT retry:`, err.message);
    return false;
  }
}

/** The daily job. Never throws past the scheduler's own catch. */
async function runNewMemberEmails({ now = new Date() } = {}) {
  if (!EMAIL_VERIFICATION_ENABLED) return { sent: 0 };
  const { enabled, since } = await getSettings();
  if (!enabled || !since) return { sent: 0 };

  const candidates = await findCandidates({ runAt: now, since, live: true });
  let sent = 0;
  for (const { user, choice } of candidates) {
    if (choice !== 'cellar' && choice !== 'empty') continue;
    if (await sendOne(user, choice, now)) sent += 1;
  }
  if (sent > 0) console.log(`[newMemberEmails] sent ${sent}`);
  return { sent };
}

module.exports = {
  runNewMemberEmails,
  findCandidates,
  chooseEmail,
  cellarSummary,
  getSettings,
  setEnabled,
  CONFIG_KEY,
};
