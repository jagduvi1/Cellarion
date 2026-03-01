const Notification = require('../models/Notification');

/**
 * Creates an in-app notification for a user.
 * Errors are caught and logged so a notification failure never breaks
 * the calling operation.
 */
async function createNotification(userId, type, title, message, link = null) {
  try {
    await Notification.create({ user: userId, type, title, message, link });
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err.message);
  }
}

module.exports = { createNotification };
