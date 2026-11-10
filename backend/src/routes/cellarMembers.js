// Sharing a cellar: /api/cellars/:id/members.
//
// Who may read and change a cellar besides its owner: list the members, add
// one (or invite an address that has no account yet), change a role, remove
// one. The owner's only, except that a member may remove themself.
//
// Mounted by routes/cellars.js after its requireAuth, so every handler here
// runs for a signed-in user.

const express = require('express');
const { requireNonDemo } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const PendingShare = require('../models/PendingShare');
const ClimateDevice = require('../models/ClimateDevice');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const { sendCellarInviteEmail } = require('../services/mailgun');
const { bumpDataVersion } = require('../services/dataVersion');
const { isValidId } = require('../utils/validation');

const router = express.Router();

// GET /api/cellars/:id/members - List members (owner only)
router.get('/:id/members', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null })
      .populate('members.user', 'username email');
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    res.json({ members: cellar.members });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// POST /api/cellars/:id/members - Add a member (owner only)
// requireNonDemo: inviting a member sends an email to an arbitrary address — an
// outbound-email/PII spam vector a throwaway demo must not have. A demo user can
// explore a populated cellar but can't invite others to it.
// Invitations per account per rolling 24 h. A household shares a handful of
// cellars with a handful of people; twenty is generous.
const INVITES_PER_DAY = 20;

router.post('/:id/members', requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' });
    }
    if (!['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer or editor' });
    }

    // deletedAt: null — an invitation to a soft-deleted cellar would send an
    // email and a notification pointing at a cellar the invitee can never see.
    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const normalizedEmail = String(email).toLowerCase().trim();
    // The invite path relays text the caller chooses (the cellar name) to any
    // mailbox: only real addresses, and no more than INVITES_PER_DAY
    // invitations per account per rolling day.
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }

    // Look up user by email
    const userToAdd = await User.findOne({ email: normalizedEmail });

    // Can't share with yourself
    if (userToAdd && userToAdd._id.toString() === req.user.id.toString()) {
      return res.status(400).json({ error: 'Cannot share a cellar with yourself' });
    }

    if (!userToAdd) {
      // User doesn't exist — create a pending invite and send an email
      const existingPending = await PendingShare.findOne({ email: normalizedEmail, cellar: cellar._id });
      if (existingPending) {
        return res.status(400).json({ error: 'An invitation has already been sent to this email' });
      }

      const sentToday = await PendingShare.countDocuments({ invitedBy: req.user.id, createdAt: { $gte: new Date(Date.now() - 24 * 3600e3) } });
      if (sentToday >= INVITES_PER_DAY) {
        logAudit(req, 'system.rate_limit_exceeded', { type: 'cellar', id: cellar._id }, { limiter: 'cellarInvites', limit: INVITES_PER_DAY });
        return res.status(429).json({ error: 'Too many invitations sent today. Please try again tomorrow.' });
      }

      const sharingUser = await User.findById(req.user.id).select('username email').lean();

      await PendingShare.create({
        email: normalizedEmail,
        cellar: cellar._id,
        role,
        invitedBy: req.user.id
      });

      sendCellarInviteEmail(
        normalizedEmail,
        sharingUser?.username ?? 'A Cellarion user',
        sharingUser?.email ?? '',
        String(cellar.name || '').slice(0, 100),
        role
      ).catch(err => {
        console.error('Failed to send cellar invite email:', err.message);
      });

      logAudit(req, 'cellar.share.invite',
        { type: 'cellar', id: cellar._id, cellarId: cellar._id },
        { invitedEmail: normalizedEmail, role }
      );

      return res.status(202).json({
        invited: true,
        message: `Invitation sent to ${normalizedEmail}. The cellar will be shared when they join Cellarion.`
      });
    }

    // Check if already a member
    const alreadyMember = cellar.members.some(
      m => m.user.toString() === userToAdd._id.toString()
    );
    if (alreadyMember) {
      return res.status(400).json({ error: 'User is already a member of this cellar' });
    }

    cellar.members.push({ user: userToAdd._id, role });
    await cellar.save();
    bumpDataVersion(userToAdd._id);

    const sharingUser = await User.findById(req.user.id).select('username').lean();
    createNotification(
      userToAdd._id,
      'cellar_shared',
      'Cellar shared with you',
      `${sharingUser?.username ?? 'Someone'} shared their cellar "${cellar.name}" with you (${role}).`,
      '/cellars'
    );

    logAudit(req, 'cellar.share.add',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { sharedWith: userToAdd.email, role }
    );

    await cellar.populate('members.user', 'username email');
    res.status(201).json({ members: cellar.members });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// PUT /api/cellars/:id/members/:userId - Change a member's role (owner only)
router.put('/:id/members/:userId', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid ID' });
    const { role } = req.body;
    if (!role || !['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer or editor' });
    }

    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const member = cellar.members.find(m => m.user.toString() === req.params.userId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const previousRole = member.role;
    member.role = role;
    await cellar.save();
    bumpDataVersion(req.params.userId);

    // Assigning a climate device to a cellar requires owner/editor. If this
    // member is downgraded to viewer, detach any device they had assigned here
    // so a demoted collaborator can't keep writing readings into the cellar.
    if (previousRole === 'editor' && role === 'viewer') {
      await ClimateDevice.updateMany(
        { cellar: cellar._id, user: req.params.userId },
        { $set: { cellar: null } }
      );
    }

    logAudit(req, 'cellar.share.update',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { memberId: req.params.userId, from: previousRole, to: role }
    );

    await cellar.populate('members.user', 'username email');
    res.json({ members: cellar.members });
  } catch (error) {
    console.error('Update member role error:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

// DELETE /api/cellars/:id/members/:userId - Remove a member (owner, or self-removal)
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findById(req.params.id);
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const isOwner = cellar.user.toString() === req.user.id.toString();
    const isSelf = req.params.userId === req.user.id.toString();
    if (!isOwner && !isSelf) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const memberIndex = cellar.members.findIndex(
      m => m.user.toString() === req.params.userId
    );
    if (memberIndex === -1) return res.status(404).json({ error: 'Member not found' });

    cellar.members.splice(memberIndex, 1);
    await cellar.save();
    bumpDataVersion(req.params.userId);

    // Detach any climate devices the removed member had assigned to this
    // cellar — otherwise their token keeps posting readings into a cellar they
    // no longer have access to, and their alerts keep leaking its live name and
    // thresholds (device assignment was role-checked only at assignment time).
    await ClimateDevice.updateMany(
      { cellar: cellar._id, user: req.params.userId },
      { $set: { cellar: null } }
    );

    logAudit(req, 'cellar.share.remove',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { removedUserId: req.params.userId }
    );

    res.json({ message: 'Member removed successfully' });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
