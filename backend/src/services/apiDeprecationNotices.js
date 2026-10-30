/**
 * Telling the owner of a token that still calls a deprecated route
 * (config/apiDeprecations). Headers and release notes reach only the
 * developers who read them, and the person whose integration will break is
 * the token's owner, so the token is marked with its own deprecated use
 * (ApiToken.deprecatedUse) and its owner is told:
 *  - once, on its first such call, in the app and by email
 *    (markTokenDeprecatedUse, from middleware/apiTokenAuth);
 *  - again REMINDER_DAYS before SUNSET, if the token still called one in the
 *    last 30 days (runDeprecationReminders, daily from services/scheduler);
 *  - on the token itself in Settings → API tokens (deprecatedUseView).
 *
 * Every notice is claimed by an atomic conditional update on the token BEFORE
 * it goes out, so a restart, a retry or a second process can never send one
 * twice; a send that fails after its claim is lost, never repeated. Nothing
 * here names a route: what is deprecated is DEPRECATED_RULES, and when it
 * ends is SUNSET.
 *
 * The email is a service message about the owner's own integration, like the
 * lockout alert: it goes out whatever their email settings. It is bounded —
 * the first notice plus one per REMINDER_DAYS entry, per token — and stops by
 * itself once the token stops calling these routes or is revoked.
 */
const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const { SUNSET } = require('../config/apiDeprecations');
const { matchedRoute } = require('./apiDeprecation');
const { createNotification } = require('./notifications');
const { sendApiDeprecationEmail, EMAIL_VERIFICATION_ENABLED } = require('./mailgun');
const { logAudit } = require('./audit');

const DAY_MS = 24 * 60 * 60 * 1000;

// The marker's lastAt is written at most once an hour per token (a new
// route is written at once): an integration polling a deprecated route must
// not turn every answer into a write. Same pace as ApiToken.lastUsedAt.
const MARK_THROTTLE_MS = 60 * 60 * 1000;
// "Still uses it": a call within this window. Gates the reminders and the
// warning in Settings, so a token that moved on stops being told.
const RECENT_USE_MS = 30 * DAY_MS;
// Reminders, in days before SUNSET. Each goes once per token, and only to a
// token whose first notice went out before that day: one first noticed
// later was already told, recently.
const REMINDER_DAYS = [90, 30];
// The least time between two notices to one token, so a reminder never
// lands days after the first notice or a previous reminder; it waits.
const REMINDER_MIN_GAP_MS = 7 * DAY_MS;
// Tokens reminded per run; the rest wait for the next day's run.
const MAX_PER_RUN = 500;
const EMAIL_TIMEOUT_MS = 10 * 1000;
// Settings → API tokens, where the token shows the warning (SettingsGroup alias).
const TOKENS_LINK = '/settings#api-tokens';
const MAX_ROUTES_SHOWN = 5;

const OWNER_FIELDS = 'email emailVerified username displayName isDemo deletionScheduledFor';

const longDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const forSunset = (mark) => !!(mark && mark.sunset && new Date(mark.sunset).getTime() === SUNSET.getTime());

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), EMAIL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Mark the token with this answered call (on the response's 'finish', after
 * middleware/apiTokenAuth classified the request as deprecated), and send
 * the first notice the first time. Same route key and same rule as the
 * anonymous count (services/apiDeprecation): the route Express matched, and
 * only an answer below 400. Fire-and-forget: never throws, and the request
 * has already been answered.
 *
 * `token` is the document the request authenticated with, read at its start.
 */
async function markTokenDeprecatedUse(token, req, res, now = new Date()) {
  try {
    if (!token || token.origin === 'oauth') return;
    if (now.getTime() >= SUNSET.getTime()) return;
    const route = matchedRoute(req);
    if (!route || res.statusCode >= 400) return;
    // Without a live connection Mongoose would queue the write for seconds.
    if (ApiToken.db && ApiToken.db.readyState !== 1) return;

    const mark = token.deprecatedUse;
    const current = forSunset(mark);
    // Personal, active tokens only: an OAuth token never reaches a deprecated
    // route (it is confined to the MCP endpoint), and a token revoked since
    // the request began is left alone.
    const target = { _id: token._id, revokedAt: null, origin: { $ne: 'oauth' } };
    const addUse = () => ApiToken.updateOne(
      { ...target, 'deprecatedUse.sunset': SUNSET },
      { $set: { 'deprecatedUse.lastAt': now }, $addToSet: { 'deprecatedUse.routes': route } },
    );

    if (!current) {
      // The first call under this deprecation, or a record from an earlier one.
      const started = await ApiToken.updateOne(
        { ...target, 'deprecatedUse.sunset': { $ne: SUNSET } },
        { $set: { deprecatedUse: { sunset: SUNSET, firstAt: now, lastAt: now, routes: [route] } } },
      );
      // Another request marked it a moment ago: add this route to its record.
      if (!started || !started.matchedCount) await addUse();
    } else {
      const known = (mark.routes || []).includes(route);
      const fresh = mark.lastAt && now.getTime() - new Date(mark.lastAt).getTime() < MARK_THROTTLE_MS;
      if (!known || !fresh) await addUse();
    }

    if (!current || !mark.notifiedAt) await notifyFirstUse(token._id, now);
  } catch (err) {
    console.error('[apiDeprecationNotices] Marking a token failed:', err.message);
  }
}

/**
 * Claim and send the first notice for a marked token. Exactly once per token
 * and sunset: only the update that finds notifiedAt unset sends it.
 */
async function notifyFirstUse(tokenId, now = new Date()) {
  // The owner is read BEFORE the claim, as the reminder path does: a failed
  // read then leaves the notice unclaimed for the next call instead of
  // losing it. An owner who is never told (demo, deletion pending) is not
  // claimed for either.
  const pre = await ApiToken.findOne({ _id: tokenId }).select('user').lean();
  if (!pre) return null;
  const owner = await User.findById(pre.user).select(OWNER_FIELDS).lean();
  if (!owner || owner.deletionScheduledFor || owner.isDemo) return null;
  const token = await ApiToken.findOneAndUpdate(
    { _id: tokenId, revokedAt: null, origin: { $ne: 'oauth' }, 'deprecatedUse.sunset': SUNSET, 'deprecatedUse.notifiedAt': null },
    { $set: { 'deprecatedUse.notifiedAt': now } },
    { new: true },
  ).select('user name deprecatedUse').lean();
  if (!token) return null;
  return sendNotice(token, { now, owner });
}

function noticeText(token, { reminderDays, daysLeft }) {
  const name = String(token.name || 'API token').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
  const routes = token.deprecatedUse?.routes || [];
  const shown = routes.slice(0, MAX_ROUTES_SHOWN);
  const more = routes.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${more} more` : (shown.join(', ') || 'deprecated routes');
  const date = longDate(SUNSET);
  const one = routes.length === 1;
  return {
    title: reminderDays
      ? `Reminder: API token "${name}" uses ${one ? 'a route that stops' : 'routes that stop'} on ${date}`
      : `API token "${name}" uses ${one ? 'a route that is' : 'routes that are'} going away`,
    message: `It still calls ${list}, which ${one ? 'stops' : 'stop'} answering API tokens on ${date}`
      + `${reminderDays ? `, in ${daysLeft} days` : ''}. GET /api/inventory covers most uses.`,
  };
}

/**
 * The notice itself: the bell (and push where the owner has it on), the
 * email to a verified address, and one audit row. `reminderDays` is unset for
 * the first notice. Resolves to what went out.
 */
async function sendNotice(token, { reminderDays = null, now = new Date(), owner = null } = {}) {
  const user = owner || await User.findById(token.user).select(OWNER_FIELDS).lean();
  if (!user || user.deletionScheduledFor || user.isDemo) return { notified: false, emailed: false };

  const routes = token.deprecatedUse?.routes || [];
  const daysLeft = Math.max(1, Math.ceil((SUNSET.getTime() - now.getTime()) / DAY_MS));
  const { title, message } = noticeText(token, { reminderDays, daysLeft });
  await createNotification(user._id, 'api_deprecation', title, message, TOKENS_LINK);

  let emailed = false;
  if (EMAIL_VERIFICATION_ENABLED && user.email && user.emailVerified) {
    try {
      await withTimeout(sendApiDeprecationEmail(user.email, user.displayName || user.username || 'there', {
        tokenName: token.name,
        routes,
        sunset: SUNSET,
        lastUsedAt: token.deprecatedUse?.lastAt || null,
        // The first notice names only the reminders still ahead of it.
        ...(reminderDays ? { daysLeft } : { reminderDays: REMINDER_DAYS.filter((d) => daysLeft > d) }),
      }));
      emailed = true;
    } catch (err) {
      console.error('[apiDeprecationNotices] Email failed:', err.message);
    }
  }

  // About the account, from the system: the user's export and the erasure
  // scrub find system rows by resource { type: 'user' } (userDataRegistry).
  // The token's name stays out of it; its id says which one.
  logAudit(null, 'token.deprecation_notice', { type: 'user', id: user._id }, {
    tokenId: String(token._id),
    notice: reminderDays ? `reminder_${reminderDays}d` : 'first',
    routes,
    emailed,
  });
  return { notified: true, emailed };
}

/** The reminder due on `now`: the latest of REMINDER_DAYS whose day has come. */
function dueReminder(now) {
  let due = null;
  for (const days of REMINDER_DAYS) {
    const at = new Date(SUNSET.getTime() - days * DAY_MS);
    if (now.getTime() >= at.getTime() && (!due || days < due.days)) due = { days, at };
  }
  return due;
}

/**
 * The daily run (services/scheduler): clear the records whose sunset has
 * passed, then send the reminder that is due to every active personal token
 * still calling a deprecated route. Nothing is sent from SUNSET on.
 */
async function runDeprecationReminders(now = new Date()) {
  const result = { cleared: 0, due: null, sent: 0, emailed: 0 };
  // Retention: past its sunset the record means nothing — the routes answer
  // tokens 403 and Settings no longer shows it.
  const cleared = await ApiToken.updateMany({ 'deprecatedUse.sunset': { $lte: now } }, { $unset: { deprecatedUse: 1 } });
  result.cleared = cleared?.modifiedCount || 0;
  if (now.getTime() >= SUNSET.getTime()) return result;

  const due = dueReminder(now);
  if (!due) return result;
  result.due = due.days;

  const gapStart = new Date(now.getTime() - REMINDER_MIN_GAP_MS);
  const tokens = await ApiToken.find({
    revokedAt: null,
    origin: { $ne: 'oauth' },
    'deprecatedUse.sunset': SUNSET,
    'deprecatedUse.lastAt': { $gte: new Date(now.getTime() - RECENT_USE_MS) },
    // First noticed before this reminder's day, and not within the gap.
    'deprecatedUse.notifiedAt': { $lt: new Date(Math.min(due.at.getTime(), gapStart.getTime())) },
    'deprecatedUse.reminders.daysBefore': { $ne: due.days },
    'deprecatedUse.reminders.at': { $not: { $gt: gapStart } },
  }).select('user').limit(MAX_PER_RUN).lean();
  if (tokens.length === 0) return result;

  const owners = await User.find({ _id: { $in: [...new Set(tokens.map((t) => String(t.user)))] } })
    .select(OWNER_FIELDS).lean();
  const ownerById = new Map(owners.map((u) => [String(u._id), u]));

  for (const candidate of tokens) {
    const owner = ownerById.get(String(candidate.user));
    // Checked before the claim: an account that is going away is not told,
    // and keeps the reminder should the deletion be cancelled.
    if (!owner || owner.deletionScheduledFor || owner.isDemo) continue;
    try {
      const token = await ApiToken.findOneAndUpdate(
        { _id: candidate._id, revokedAt: null, origin: { $ne: 'oauth' }, 'deprecatedUse.sunset': SUNSET, 'deprecatedUse.reminders.daysBefore': { $ne: due.days } },
        { $push: { 'deprecatedUse.reminders': { daysBefore: due.days, at: now } } },
        { new: true },
      ).select('user name deprecatedUse').lean();
      if (!token) continue; // another run sent it, or the token was revoked
      const sent = await sendNotice(token, { reminderDays: due.days, now, owner });
      if (sent.notified) result.sent++;
      if (sent.emailed) result.emailed++;
    } catch (err) {
      console.error('[apiDeprecationNotices] Reminder failed:', err.message);
    }
  }
  return result;
}

/**
 * What Settings shows on a token (routes/tokens): its recent deprecated use
 * under the current sunset, or null.
 */
function deprecatedUseView(mark, now = new Date()) {
  if (!forSunset(mark) || now.getTime() >= SUNSET.getTime()) return null;
  const lastAt = mark.lastAt ? new Date(mark.lastAt) : null;
  if (!lastAt || now.getTime() - lastAt.getTime() > RECENT_USE_MS) return null;
  return { routes: [...(mark.routes || [])], firstAt: mark.firstAt || null, lastAt, sunset: SUNSET };
}

module.exports = {
  markTokenDeprecatedUse,
  notifyFirstUse,
  runDeprecationReminders,
  deprecatedUseView,
  dueReminder,
  MARK_THROTTLE_MS,
  RECENT_USE_MS,
  REMINDER_DAYS,
  REMINDER_MIN_GAP_MS,
};
