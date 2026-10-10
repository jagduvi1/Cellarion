/**
 * Early access — a feature flag's state change and the notices it sends
 * (config/featureFlags). Kept out of the super-admin route so the rules live
 * in one place and are tested on their own:
 *
 * - A feature ENTERING beta is announced once to every user who tries new
 *   features early (User.preferences.earlyAccess).
 * - A beta feature going out to EVERYONE thanks once every user who sent
 *   feedback on it (a 'beta' support ticket naming the feature).
 *
 * "Once": the flag's stored row records when each notice went out, so moving
 * a flag back and forth never repeats one. Demo accounts are left out — they
 * are gone within the hour.
 */
const User = require('../models/User');
const SupportTicket = require('../models/SupportTicket');
const featureFlags = require('../config/featureFlags');
const { updateSiteConfig } = require('../utils/siteConfig');
const { createNotifications } = require('./notifications');

// Settings → Early access lists every feature in beta with where to find it.
const LINK = '/settings#early-access';
const BATCH = 500;

// Resolves to how many rows were really created (createNotifications never
// throws: a refused insert comes back as fewer rows, not as an error).
async function notifyInBatches(userIds, build) {
  let created = 0;
  for (let i = 0; i < userIds.length; i += BATCH) {
    const rows = await createNotifications(userIds.slice(i, i + BATCH).map(build));
    created += Array.isArray(rows) ? rows.length : 0;
  }
  return created;
}

async function optedInUserIds() {
  const rows = await User.find({ 'preferences.earlyAccess': true, isDemo: { $ne: true } }).select('_id').lean();
  return rows.map((r) => r._id);
}

async function feedbackUserIds(key) {
  return SupportTicket.distinct('user', { category: 'beta', feature: key });
}

/**
 * Change one flag — its state and/or its forum thread — persist it, and send
 * the notices the change calls for. `patch.forumPath` must already be parsed
 * (featureFlags.parseForumPath).
 * Returns { error } or { before, after, notified: { announced, thanked } }.
 */
async function changeFlag(key, patch, actorId) {
  const before = featureFlags.get(key);
  if (!before) return { error: { status: 404, message: 'Unknown feature' } };
  const { state, forumPath } = patch || {};
  if (state !== undefined && !featureFlags.STATES.includes(state)) {
    return { error: { status: 400, message: `state must be one of: ${featureFlags.STATES.join(', ')}` } };
  }

  const rows = featureFlags.storedValue();
  const row = { ...rows[key] };
  const now = new Date().toISOString();
  if (state !== undefined && state !== before.state) {
    row.state = state;
    if (state === 'beta' && !row.betaAt) row.betaAt = now;
    // Released means out for everyone now; a flag taken back loses the date.
    row.releasedAt = state === 'everyone' ? now : null;
  }
  if (forumPath !== undefined) row.forumPath = forumPath;

  const announce = row.state === 'beta' && before.state !== 'beta' && !row.betaNotifiedAt;
  const thank = row.state === 'everyone' && before.state !== 'everyone' && !row.releasedNotifiedAt;
  if (announce) row.betaNotifiedAt = now;
  if (thank) row.releasedNotifiedAt = now;

  rows[key] = row;
  await updateSiteConfig('featureFlags', rows, actorId);
  featureFlags.set(rows);
  const after = featureFlags.get(key);

  // The flag is saved either way; a notice that cannot go out is logged,
  // never a failed change.
  const notified = { announced: 0, thanked: 0 };
  try {
    if (announce) {
      notified.announced = await notifyInBatches(await optedInUserIds(), (userId) => ({
        userId,
        type: 'early_access_new',
        title: `New in early access: ${after.title}`,
        message: 'You try new features early, so it is on for you now. It carries a Beta badge with a button for your feedback.',
        link: LINK,
        category: 'earlyAccess',
      }));
    }
    if (thank) {
      notified.thanked = await notifyInBatches(await feedbackUserIds(key), (userId) => ({
        userId,
        type: 'early_access_released',
        title: `Now for everyone: ${after.title}`,
        message: 'It has left early access and is on for every member. Thank you for your feedback on it.',
        link: LINK,
        category: 'earlyAccess',
      }));
    }
  } catch (err) {
    console.error('[earlyAccess] Notices for a flag change failed:', err.message);
  }

  return { before, after, notified };
}

/**
 * The numbers the super-admin panel shows: how many members try new features
 * early, and per feature how much beta feedback came in (all / still open).
 */
async function overview() {
  const [optedIn, feedback] = await Promise.all([
    User.countDocuments({ 'preferences.earlyAccess': true, isDemo: { $ne: true } }),
    SupportTicket.aggregate([
      { $match: { category: 'beta', feature: { $in: [...featureFlags.FEATURE_KEYS] } } },
      { $group: { _id: '$feature', total: { $sum: 1 }, open: { $sum: { $cond: [{ $ne: ['$status', 'closed'] }, 1, 0] } } } },
    ]),
  ]);
  const byKey = new Map(feedback.map((f) => [f._id, { total: f.total, open: f.open }]));
  return {
    optedIn,
    features: featureFlags.list().map((f) => ({
      key: f.key,
      title: f.title,
      state: f.state,
      betaAt: f.betaAt,
      releasedAt: f.releasedAt,
      forumPath: f.forumPath,
      feedback: byKey.get(f.key) || { total: 0, open: 0 },
    })),
  };
}

module.exports = { changeFlag, overview };
