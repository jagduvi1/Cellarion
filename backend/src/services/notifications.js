const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');

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
  try {
    await Notification.create({ user: userId, type, title, message, link });
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err.message);
  }

  // Web push — fire and forget
  if (!VAPID_CONFIGURED) return;
  try {
    const user = await User.findById(userId).select('preferences.notifications').lean();
    const prefs = user?.preferences?.notifications;
    if (!prefs) return;

    // Category-specific gate when the caller named one — otherwise permissive.
    let pushAllowed;
    const prefKey = category ? PUSH_PREF_PATH[category] : null;
    if (prefKey) {
      pushAllowed = !!prefs[prefKey]?.push;
    } else {
      // Legacy / uncategorised path: fire if any of the known push toggles
      // are on. Avoids silently dropping notifications for callers that
      // haven't been migrated to pass a category yet.
      pushAllowed = Object.values(PUSH_PREF_PATH).some(k => !!prefs[k]?.push);
    }
    if (!pushAllowed) return;

    const subs = await PushSubscription.find({ user: userId }).lean();
    if (subs.length === 0) return;

    const payload = JSON.stringify({ title, message, link, tag: type });

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload
          );
        } catch (err) {
          // 410 Gone = subscription expired; clean it up
          if (err.statusCode === 410 || err.statusCode === 404) {
            await PushSubscription.deleteOne({ _id: sub._id });
          }
        }
      })
    );
  } catch (err) {
    console.error('[notifications] Push dispatch error:', err.message);
  }
}

module.exports = { createNotification };
