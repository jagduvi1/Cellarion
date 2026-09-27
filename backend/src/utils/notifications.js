/**
 * Notification-preferences helpers.
 *
 * The User schema stores notification settings as a tree of per-category
 * sub-objects under `preferences.notifications` (see models/User.js):
 *
 *   notifications: {
 *     drinkWindow:     { enabled, email, push },
 *     communityReply:  { email, push },
 *     communityMention:{ email, push },
 *     communityFollow: { push },                 // no email — too noisy
 *     supportReply:    { email },                // support answered your ticket
 *   }
 *
 * There is NO top-level `email` / `push` flag — writing to one is silently
 * dropped by Mongoose's strict mode (which is what caused the unsubscribe
 * GDPR bug fixed in this module's reason-for-existence). All outbound-channel
 * flags live one level deeper, per category.
 *
 * Anything that mutates these flags should go through this helper so adding
 * a new category in User.js automatically wires through to the settings UI,
 * the unsubscribe one-click handler, and the regression test.
 */

// Canonical list of notification categories with the outbound channels the
// schema defines for each. Adding a new outbound-notification category to
// User.js means adding it here — the unsubscribe handler and the related test
// then cover it automatically. The in-app bell (drinkWindow.enabled) is
// intentionally NOT a channel — it's a pull surface, not an interruptive one,
// and stays on per the schema comment.
const CATEGORY_CHANNELS = {
  drinkWindow: ['email', 'push'],
  communityReply: ['email', 'push'],
  communityMention: ['email', 'push'],
  communityFollow: ['push'],
  supportReply: ['email'],
};

const NOTIFICATION_CATEGORIES = Object.keys(CATEGORY_CHANNELS);

// Outbound channels we treat as "subject to unsubscribe".
const OUTBOUND_CHANNELS = ['email', 'push'];

/**
 * Turn every outbound channel (email / push) of every category off, and record
 * the objection itself. Used by GET /api/users/unsubscribe to honour a
 * one-click opt-out from any Cellarion email.
 *
 * Every channel the schema defines is written, whether or not the stored
 * record has it yet: a category added after the user's settings were saved
 * (support replies, 2026-09-26) must go off with the rest, and the settings
 * page must show it off. `emailOptOutAt` is stamped as well — every sender
 * honours it on top of the per-category flags, so a category added LATER
 * starts off for this user too (audit 2026-09-27 M7). Settings clears it when
 * the user turns any email back on (services/accountOps).
 *
 * Returns true if anything was changed (useful for tests and audit logging).
 * Calls `user.markModified` on each touched parent path so Mongoose writes a
 * whole-object replacement and the changes actually land (see the
 * legacy-notifications healing in models/User.js for the same pattern —
 * issue #390 turned dotted $set into a fatal Mongo error).
 *
 * @param {object} user  Mongoose User document (or a plain object with the
 *                       same shape, for unit tests). Must have a
 *                       markModified function and a preferences subtree.
 * @returns {boolean}    true iff anything was changed.
 */
function unsubscribeAllNotifications(user) {
  const notif = user?.preferences?.notifications;
  if (!notif) return false;

  let modified = false;
  for (const category of NOTIFICATION_CATEGORIES) {
    let block = notif[category];
    let categoryTouched = false;
    for (const channel of CATEGORY_CHANNELS[category]) {
      if (!block) {
        block = {};
        notif[category] = block;
      }
      if (block[channel] !== false) {
        block[channel] = false;
        categoryTouched = true;
      }
    }
    if (categoryTouched) {
      modified = true;
      if (typeof user.markModified === 'function') {
        user.markModified(`preferences.notifications.${category}`);
      }
    }
  }
  if (!user.emailOptOutAt) {
    user.emailOptOutAt = new Date();
    modified = true;
  }
  return modified;
}

module.exports = {
  CATEGORY_CHANNELS,
  NOTIFICATION_CATEGORIES,
  OUTBOUND_CHANNELS,
  unsubscribeAllNotifications,
};
