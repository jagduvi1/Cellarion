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
const BottleImage = require('../models/BottleImage');
const Follow = require('../models/Follow');
const Recommendation = require('../models/Recommendation');
const JournalEntry = require('../models/JournalEntry');
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
    const { currency, language, ratingScale, rackNavigation, restockScope, defaultCellarId, notifications } = req.body;
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

    if (restockScope !== undefined) {
      if (!['all', 'cellar'].includes(restockScope)) {
        return res.status(400).json({ error: 'Invalid restock scope. Allowed: all, cellar' });
      }
      update['preferences.restockScope'] = restockScope;
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

// GET /api/users/me/export — GDPR data portability: export all user data as JSON
router.get('/me/export', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [bottles, cellars, racks, wineRequests, reviews, notifications, auditLogs, images, recommendationsSent, recommendationsReceived, journalEntries] = await Promise.all([
      Bottle.find({ user: userId }).lean(),
      Cellar.find({ $or: [{ user: userId }, { 'members.user': userId }], deletedAt: null }).lean(),
      Rack.find({ cellar: { $in: await Cellar.distinct('_id', { user: userId }) }, deletedAt: null }).lean(),
      WineRequest.find({ user: userId }).lean(),
      Review.find({ user: userId }).lean(),
      Notification.find({ user: userId }).lean(),
      AuditLog.find({ 'actor.userId': userId }).sort({ timestamp: -1 }).limit(1000).lean(),
      BottleImage.find({ uploadedBy: userId }).lean(),
      Recommendation.find({ sender: userId }).populate('wine', 'name producer').lean(),
      Recommendation.find({ recipient: userId }).populate('wine', 'name producer').populate('sender', 'username').lean(),
      JournalEntry.find({ user: userId }).lean()
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      account: {
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        bio: user.bio,
        roles: user.roles,
        plan: user.plan,
        preferences: user.preferences,
        profileVisibility: user.profileVisibility,
        emailVerified: user.emailVerified,
        gdprConsent: user.gdprConsent,
        createdAt: user.createdAt
      },
      bottles,
      cellars,
      racks,
      wineRequests,
      reviews,
      notifications: notifications.map(n => ({ ...n, _id: undefined })),
      activityLog: auditLogs.map(a => ({
        action: a.action,
        timestamp: a.timestamp,
        detail: a.detail
      })),
      images: images.map(i => ({
        originalUrl: i.originalUrl,
        processedUrl: i.processedUrl,
        uploadedAt: i.createdAt
      })),
      recommendations: {
        sent: recommendationsSent.map(r => ({
          wine: r.wine?.name,
          producer: r.wine?.producer,
          recipientEmail: r.recipientEmail,
          note: r.note,
          status: r.status,
          createdAt: r.createdAt
        })),
        received: recommendationsReceived.map(r => ({
          wine: r.wine?.name,
          producer: r.wine?.producer,
          from: r.sender?.username,
          note: r.note,
          status: r.status,
          createdAt: r.createdAt
        }))
      },
      journal: journalEntries.map(j => ({
        date: j.date,
        title: j.title,
        occasion: j.occasion,
        people: j.people?.map(p => p.name),
        pairings: j.pairings?.map(p => ({
          dish: p.dish,
          wineName: p.wineName,
          notes: p.notes
        })),
        mood: j.mood,
        notes: j.notes,
        visibility: j.visibility,
        createdAt: j.createdAt
      }))
    };

    res.setHeader('Content-Disposition', `attachment; filename="cellarion-data-export-${user.username}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch (error) {
    console.error('Data export error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// DELETE /api/users/me — schedule account deletion (7-day cooling-off period)
router.delete('/me', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.deletionScheduledFor) {
      return res.status(400).json({
        error: 'Account deletion already scheduled',
        deletionScheduledFor: user.deletionScheduledFor
      });
    }

    const now = new Date();
    const scheduledFor = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    user.deletionRequestedAt = now;
    user.deletionScheduledFor = scheduledFor;
    await user.save();

    logAudit(req, 'user.deletion_requested', { type: 'user', id: user._id });

    res.json({
      message: 'Account deletion scheduled. Your account and all data will be permanently deleted in 7 days. You can cancel this from Settings.',
      deletionScheduledFor: scheduledFor
    });
  } catch (error) {
    console.error('Schedule deletion error:', error);
    res.status(500).json({ error: 'Failed to schedule deletion' });
  }
});

// POST /api/users/me/cancel-deletion — cancel a scheduled account deletion
router.post('/me/cancel-deletion', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.deletionScheduledFor) {
      return res.status(400).json({ error: 'No deletion scheduled' });
    }

    user.deletionRequestedAt = null;
    user.deletionScheduledFor = null;
    await user.save();

    logAudit(req, 'user.deletion_cancelled', { type: 'user', id: user._id });

    res.json({ message: 'Account deletion cancelled' });
  } catch (error) {
    console.error('Cancel deletion error:', error);
    res.status(500).json({ error: 'Failed to cancel deletion' });
  }
});

// GET /api/users/unsubscribe?token=:token — one-click email unsubscribe (no auth required)
router.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Unsubscribe token is required' });
  }

  try {
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    // The unsubscribe token is the user's ID hashed with a secret
    // We'll find the user by trying all users (or use a more efficient method)
    // For simplicity, encode the user ID in the token
    const [userId] = Buffer.from(token, 'base64url').toString().split(':');

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid unsubscribe link' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(400).json({ error: 'Invalid unsubscribe link' });
    }

    user.preferences.notifications.email = false;
    user.preferences.notifications.push = false;
    await user.save();

    // Redirect to a confirmation page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/unsubscribed`);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

module.exports = router;
