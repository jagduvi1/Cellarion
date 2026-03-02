const express = require('express');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../services/audit');

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

router.patch('/preferences', requireAuth, async (req, res) => {
  try {
    const { currency, language } = req.body;
    const update = {};

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

module.exports = router;
