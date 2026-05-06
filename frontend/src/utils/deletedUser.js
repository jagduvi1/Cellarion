// Mirror of backend/src/utils/deletedUser.js — when a user closes their
// account, their forum posts are re-pointed at this sentinel username so
// the conversation stays intact for other users (GDPR anonymisation).
// Display helpers below render a localised "[Deleted user]" label.
export const SENTINEL_USERNAME = '__deleted__';

export function isDeletedUser(user) {
  return !!user && user.username === SENTINEL_USERNAME;
}

/**
 * Resolve the display name for a discussion or reply author. Handles the
 * deleted-account sentinel via `t('common.deletedUser')` so callers don't
 * have to repeat the check at every render site.
 */
export function authorDisplayName(user, t, fallback = 'Unknown') {
  if (!user) return fallback;
  if (isDeletedUser(user)) return t('common.deletedUser');
  return user.displayName || user.username || fallback;
}
