const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WineRequest = require('../models/WineRequest');
const Review = require('../models/Review');
const ReviewVote = require('../models/ReviewVote');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const Follow = require('../models/Follow');
const PushSubscription = require('../models/PushSubscription');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { stripHtml } = require('../utils/sanitize');

const router = express.Router();

// GET /api/users/profile - Get current user's profile (protected)
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// PATCH /api/users/preferences - Update current user's preferences
const ALLOWED_CURRENCIES = ['USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK', 'CHF', 'CAD', 'AUD'];
const ALLOWED_LANGUAGES = ['en', 'sv'];
const ALLOWED_RATING_SCALES = ['5', '20', '100'];
const ALLOWED_RACK_NAV = ['auto', 'room', 'rack'];

router.patch('/preferences', requireAuth, async (req, res) => {
  try {
    const { currency, language, ratingScale, rackNavigation, defaultCellarId, notifications } = req.body;
    const update = {};

    if (notifications !== undefined && typeof notifications === 'object') {
      if (notifications.drinkWindow !== undefined) {
        update['preferences.notifications.drinkWindow'] = !!notifications.drinkWindow;
      }
      if (notifications.email !== undefined) {
        update['preferences.notifications.email'] = !!notifications.email;
      }
      if (notifications.push !== undefined) {
        update['preferences.notifications.push'] = !!notifications.push;
      }
    }

    if (currency !== undefined) {
      if (!ALLOWED_CURRENCIES.includes(currency.toUpperCase())) {
        return res.status(400).json({ error: `Invalid currency. Allowed: ${ALLOWED_CURRENCIES.join(', ')}` });
      }
      update['preferences.currency'] = currency.toUpperCase();
    }

    if (language !== undefined) {
      if (!ALLOWED_LANGUAGES.includes(language)) {
        return res.status(400).json({ error: `Invalid language. Allowed: ${ALLOWED_LANGUAGES.join(', ')}` });
      }
      update['preferences.language'] = language;
    }

    if (ratingScale !== undefined) {
      if (!ALLOWED_RATING_SCALES.includes(String(ratingScale))) {
        return res.status(400).json({ error: `Invalid rating scale. Allowed: ${ALLOWED_RATING_SCALES.join(', ')}` });
      }
      update['preferences.ratingScale'] = String(ratingScale);
    }

    if (rackNavigation !== undefined) {
      if (!ALLOWED_RACK_NAV.includes(rackNavigation)) {
        return res.status(400).json({ error: `Invalid rack navigation. Allowed: ${ALLOWED_RACK_NAV.join(', ')}` });
      }
      update['preferences.rackNavigation'] = rackNavigation;
    }

    if (defaultCellarId !== undefined) {
      if (defaultCellarId === null) {
        update['preferences.defaultCellarId'] = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(defaultCellarId)) {
          return res.status(400).json({ error: 'Invalid cellar ID' });
        }
        const cellar = await Cellar.findOne({
          _id: defaultCellarId,
          deletedAt: null,
          $or: [{ user: req.user.id }, { 'members.user': req.user.id }]
        });
        if (!cellar) {
          return res.status(400).json({ error: 'Cellar not found or not accessible' });
        }
        update['preferences.defaultCellarId'] = defaultCellarId;
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid preferences provided' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// POST /api/users/trial - Activate the 30-day Premium trial (one-time per user)
router.post('/trial', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.trialEligible) {
      return res.status(400).json({ error: 'Trial already used' });
    }

    const planActive = user.plan === 'premium' &&
      (!user.planExpiresAt || Date.now() < new Date(user.planExpiresAt).getTime());
    if (planActive) {
      return res.status(400).json({ error: 'Already on Premium plan' });
    }

    const now = new Date();
    user.plan = 'premium';
    user.planStartedAt = now;
    user.planExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    user.trialEligible = false;
    await user.save();

    logAudit(req, 'user.trial.start', { type: 'user', id: user._id }, { endsAt: user.planExpiresAt });

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Start trial error:', error);
    res.status(500).json({ error: 'Failed to start trial' });
  }
});

// PATCH /api/users/profile - Update display name, bio, and visibility
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { displayName, bio, profileVisibility } = req.body;
    const update = {};

    if (displayName !== undefined) {
      const cleaned = stripHtml(displayName);
      if (cleaned && cleaned.length > 50) {
        return res.status(400).json({ error: 'Display name too long (max 50 characters)' });
      }
      update.displayName = cleaned || null;
    }

    if (bio !== undefined) {
      const cleaned = stripHtml(bio);
      if (cleaned && cleaned.length > 500) {
        return res.status(400).json({ error: 'Bio too long (max 500 characters)' });
      }
      update.bio = cleaned || null;
    }

    if (profileVisibility !== undefined) {
      if (!['public', 'private'].includes(profileVisibility)) {
        return res.status(400).json({ error: 'Invalid visibility. Allowed: public, private' });
      }
      update.profileVisibility = profileVisibility;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    logAudit(req, 'user.profile.update', { type: 'user', id: user._id });

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/users/search - Search for public users by username or display name
router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({
      profileVisibility: 'public',
      $or: [{ username: regex }, { displayName: regex }]
    })
      .select('username displayName bio reviewCount')
      .limit(20);

    // Check which the current user follows
    const userIds = users.map(u => u._id);
    const myFollows = await Follow.find({ follower: req.user.id, following: { $in: userIds } }).select('following');
    const followingSet = new Set(myFollows.map(f => f.following.toString()));

    const results = users.map(u => ({
      _id: u._id,
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      reviewCount: u.reviewCount,
      isFollowing: followingSet.has(u._id.toString())
    }));

    res.json({ users: results });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// GET /api/users/public/:userId - Get public profile
router.get('/public/:userId', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('username displayName bio followersCount followingCount reviewCount profileVisibility createdAt preferences.ratingScale');

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if current user follows this user
    const isFollowing = req.user.id !== req.params.userId
      ? !!(await Follow.findOne({ follower: req.user.id, following: req.params.userId }))
      : false;

    res.json({
      user: {
        _id: user._id,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        followersCount: user.followersCount,
        followingCount: user.followingCount,
        reviewCount: user.reviewCount,
        profileVisibility: user.profileVisibility,
        ratingScale: user.preferences?.ratingScale || '5',
        createdAt: user.createdAt,
        isFollowing
      }
    });
  } catch (error) {
    console.error('Get public profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// GET /api/users/all - Get all users (admin only)
router.get('/all', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = await User.find({}).select('-password');

    res.json({
      count: users.length,
      users
    });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// DELETE /api/users/me — permanently delete account and all associated data
router.delete('/me', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    // Delete all user-owned data in parallel
    const ownedCellarIds = await Cellar.distinct('_id', { user: userId });

    await Promise.all([
      // Cellar data
      Bottle.deleteMany({ user: userId }),
      Rack.deleteMany({ cellar: { $in: ownedCellarIds } }),
      Cellar.deleteMany({ user: userId }),
      // Remove user from shared cellars they are a member of
      Cellar.updateMany({ 'members.user': userId }, { $pull: { members: { user: userId } } }),
      // Social / activity
      WineRequest.deleteMany({ user: userId }),
      Review.deleteMany({ user: userId }),
      ReviewVote.deleteMany({ user: userId }),
      Follow.deleteMany({ $or: [{ follower: userId }, { following: userId }] }),
      Notification.deleteMany({ $or: [{ user: userId }, { actor: userId }] }),
      AuditLog.deleteMany({ user: userId }),
      PushSubscription.deleteMany({ user: userId }),
      CellarValueSnapshot.deleteMany({ user: userId }),
    ]);

    // Finally delete the user itself
    await User.findByIdAndDelete(userId);

    logAudit(req, 'user.account_deleted', { userId });
    res.json({ message: 'Account deleted' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
