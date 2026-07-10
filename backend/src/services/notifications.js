const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const { runConcurrent } = require('../utils/concurrency');
const eventBus = require('./eventBus');

// Max simultaneous web-push HTTPS calls per batch — a popular thread can have
// hundreds of watchers; an uncapped burst stampedes the event loop and the
// push service.
const PUSH_CONCURRENCY = 10;

let webpush;
const VAPID_CONFIGURED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (VAPID_CONFIGURED) {
  webpush = require('web-push');
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@cellarion.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Map a notification category → which `preferences.notifications.<cat>.push`
// flag gates web-push delivery. New community categories (Phase 5) read
// per-category prefs; older subsystems pass undefined and fall back to a
// permissive "any push enabled" check so they keep working.
const PUSH_PREF_PATH = {
  drinkWindow: 'drinkWindow',
  communityReply: 'communityReply',
  communityMention: 'communityMention',
  communityFollow: 'communityFollow'
};

/**
 * Creates an in-app notification for a user, and dispatches a web-push
 * notification if the user has opted in and has active subscriptions.
 * Errors are caught and logged so a notification failure never breaks
 * the calling operation.
 *
 * @param {string} userId
 * @param {string} type   — Notification.type enum
 * @param {string} title
 * @param {string} message
 * @param {string} [link]
 * @param {string} [category] — preference category that gates push delivery
 *   ('drinkWindow' | 'communityReply' | 'communityMention' | 'communityFollow').
 *   When omitted, falls back to "any push toggle enabled" — covers legacy
 *   callers (recommendations, restock checker, etc.) that don't yet have
 *   per-category prefs.
 */
async function createNotification(userId, type, title, message, link = null, category) {
  return createNotifications([{ userId, type, title, message, link, category }]);
}

// Push-preference gate: category-specific when the caller named one,
// otherwise permissive ("any push toggle enabled") so legacy callers that
// haven't been migrated to pass a category keep working.
function pushAllowedFor(prefs, category) {
  if (!prefs) return false;
  const prefKey = category ? PUSH_PREF_PATH[category] : null;
  if (prefKey) return !!prefs[prefKey]?.push;
  return Object.values(PUSH_PREF_PATH).some(k => !!prefs[k]?.push);
}

async function sendToSubscription(sub, payload) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
  } catch (err) {
    // 410 Gone = subscription expired; clean it up
    if (err.statusCode === 410 || err.statusCode === 404) {
      await PushSubscription.deleteOne({ _id: sub._id });
    }
  }
}

/**
 * Batch variant for fan-out callers — one forum reply can notify hundreds of
 * watchers. One insertMany for the in-app rows, one prefs query and one
 * subscription query for ALL recipients, and push delivery capped at
 * PUSH_CONCURRENCY instead of an unbounded burst of per-recipient queries
 * and HTTPS calls inside the request handler.
 *
 * @param {Array<{userId, type, title, message, link?, category?}>} items
 */
async function createNotifications(items) {
  if (!items || items.length === 0) return;

  let created = [];
  try {
    created = await Notification.insertMany(
      items.map(i => ({ user: i.userId, type: i.type, title: i.title, message: i.message, link: i.link || null })),
      { ordered: false }
    );
  } catch (err) {
    // ordered:false rejects AFTER inserting the valid rows — those users must
    // still get their SSE nudge (the bulk-write error carries the inserted docs).
    created = err?.insertedDocs || [];
    console.error('[notifications] Failed to create notifications:', err.message);
  }
  // SSE push nudge (docs/ha-push-events.md §1) — debounced per user in the
  // bus, no-op for users without an open stream. Payload is informational
  // only; clients refresh via REST on any event.
  for (const doc of created) {
    eventBus.emit(doc.user, 'notification', { id: doc._id.toString(), type: doc.type });
  }

  // Web push — fire and forget
  if (!VAPID_CONFIGURED) return;
  try {
    const userIds = [...new Set(items.map(i => String(i.userId)))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('preferences.notifications')
      .lean();
    const prefsById = new Map(users.map(u => [String(u._id), u.preferences?.notifications]));

    const allowed = items.filter(i => pushAllowedFor(prefsById.get(String(i.userId)), i.category));
    if (allowed.length === 0) return;

    const allowedIds = [...new Set(allowed.map(i => String(i.userId)))];
    const subs = await PushSubscription.find({ user: { $in: allowedIds } }).lean();
    if (subs.length === 0) return;

    const subsByUser = new Map();
    for (const sub of subs) {
      const key = String(sub.user);
      if (!subsByUser.has(key)) subsByUser.set(key, []);
      subsByUser.get(key).push(sub);
    }

    const tasks = [];
    for (const item of allowed) {
      const userSubs = subsByUser.get(String(item.userId));
      if (!userSubs) continue;
      const payload = JSON.stringify({ title: item.title, message: item.message, link: item.link || null, tag: item.type });
      for (const sub of userSubs) {
        tasks.push(() => sendToSubscription(sub, payload));
      }
    }
    await runConcurrent(tasks, PUSH_CONCURRENCY);
  } catch (err) {
    console.error('[notifications] Push dispatch error:', err.message);
  }
}

module.exports = { createNotification, createNotifications };
