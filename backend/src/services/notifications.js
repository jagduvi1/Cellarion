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

/**
 * Creates an in-app notification for a user, and dispatches a web-push
 * notification if the user has opted in and has active subscriptions.
 * Errors are caught and logged so a notification failure never breaks
 * the calling operation.
 */
async function createNotification(userId, type, title, message, link = null) {
  try {
    await Notification.create({ user: userId, type, title, message, link });
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err.message);
  }

  // Web push — fire and forget
  if (!VAPID_CONFIGURED) return;
  try {
    const user = await User.findById(userId).select('preferences.notifications').lean();
    if (!user?.preferences?.notifications?.push) return;

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
