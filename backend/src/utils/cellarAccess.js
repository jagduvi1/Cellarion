/**
 * Returns the requesting user's role in a cellar:
 *   'owner'  — the cellar belongs to this user
 *   'editor' — user is a member with edit access
 *   'viewer' — user is a member with read-only access
 *   null     — user has no access
 */
function getCellarRole(cellar, userId) {
  if (!cellar || !userId) return null;
  // Handle both populated (Document with ._id) and unpopulated (ObjectId) cases
  const ownerId = cellar.user?._id ?? cellar.user;
  if (ownerId.toString() === userId.toString()) return 'owner';
  const member = cellar.members?.find(m => {
    const memberId = m.user?._id ?? m.user;
    return memberId.toString() === userId.toString();
  });
  return member ? member.role : null;
}

module.exports = { getCellarRole };
