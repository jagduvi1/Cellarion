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

// Canonical list of notification categories. Adding a new outbound-notification
// category to User.js means appending its key here — the unsubscribe handler
// and the related test then cover it automatically.
const NOTIFICATION_CATEGORIES = [
  'drinkWindow',
  'communityReply',
  'communityMention',
  'communityFollow',
];

// Outbound channels we treat as "subject to unsubscribe". The in-app bell
// (drinkWindow.enabled) is intentionally NOT here — it's a pull surface, not
// an interruptive channel, and stays on per the schema comment.
const OUTBOUND_CHANNELS = ['email', 'push'];

/**
 * Flip every outbound-channel flag (email / push) across every category to
 * false. Used by GET /api/users/unsubscribe to honour a one-click opt-out
 * from any Cellarion email.
 *
 * Returns true if at least one flag was actually changed (useful for tests
 * and audit logging). Calls `user.markModified` on each touched parent path
 * so Mongoose writes a whole-object replacement and the changes actually
 * land (see the legacy-notifications healing in models/User.js for the same
 * pattern — issue #390 turned dotted $set into a fatal Mongo error).
 *
 * @param {object} user  Mongoose User document (or a plain object with the
 *                       same shape, for unit tests). Must have a
 *                       markModified function and a preferences subtree.
 * @returns {boolean}    true iff any flag was flipped.
 */
function unsubscribeAllNotifications(user) {
  const notif = user?.preferences?.notifications;
  if (!notif) return false;

  let modified = false;
  for (const category of NOTIFICATION_CATEGORIES) {
    const block = notif[category];
    if (!block) continue;
    let categoryTouched = false;
    for (const channel of OUTBOUND_CHANNELS) {
      // Only flip channels actually defined for this category. drinkWindow has
      // both, communityFollow has only push, etc. — checking for `boolean`
      // skips undefined slots without adding new ones to the document.
      if (typeof block[channel] === 'boolean' && block[channel] !== false) {
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
  return modified;
}

module.exports = {
  NOTIFICATION_CATEGORIES,
  OUTBOUND_CHANNELS,
  unsubscribeAllNotifications,
};
