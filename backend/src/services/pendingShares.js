const PendingShare = require('../models/PendingShare');
const Cellar = require('../models/Cellar');
const { createNotification } = require('./notifications');

/**
 * Resolve any pending cellar shares for a newly registered / verified / SSO user.
 * Adds the user as a member to each cellar and creates notifications.
 *
 * Extracted from routes/auth.js so the password-signup and SSO-signup paths
 * share one implementation — a user invited to a cellar by email gets the share
 * whether they finish onboarding with a password or with "Sign in with Google".
 */
async function resolvePendingShares(user) {
  try {
    const pending = await PendingShare.find({ email: user.email }).populate('invitedBy', 'username').populate('cellar', 'name');
    if (!pending.length) return;

    for (const invite of pending) {
      // Skip if cellar was deleted or user is already a member
      if (!invite.cellar) continue;
      const cellar = await Cellar.findById(invite.cellar._id);
      if (!cellar || cellar.deletedAt) continue;

      const alreadyMember = cellar.members.some(m => m.user.toString() === user._id.toString());
      if (alreadyMember) continue;

      cellar.members.push({ user: user._id, role: invite.role });
      await cellar.save();

      createNotification(
        user._id,
        'cellar_shared',
        'Cellar shared with you',
        `${invite.invitedBy?.username ?? 'Someone'} shared their cellar "${invite.cellar.name}" with you (${invite.role}).`,
        '/cellars'
      );
    }

    await PendingShare.deleteMany({ email: user.email });
  } catch (err) {
    console.error('Failed to resolve pending shares:', err.message);
  }
}

module.exports = { resolvePendingShares };
