const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Recommendation = require('../models/Recommendation');
const WineDefinition = require('../models/WineDefinition');
const User = require('../models/User');
const Follow = require('../models/Follow');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const { sendRecommendationEmail, EMAIL_VERIFICATION_ENABLED } = require('../services/mailgun');
const { parsePagination } = require('../utils/pagination');

const router = express.Router();
router.use(requireAuth);

const isValidId = (id) => typeof id === 'string' && mongoose.isValidObjectId(id);

// GET /api/recommendations — list recommendations received by the current user
router.get('/', async (req, res) => {
  try {
    const { limit, offset: skip } = parsePagination(req.query, { limit: 20, maxLimit: 50 });

    const query = { recipient: new mongoose.Types.ObjectId(req.user.id) };

    const [items, total] = await Promise.all([
      Recommendation.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('sender', 'username displayName')
        .populate('wine', 'name producer appellation country region image')
        .lean(),
      Recommendation.countDocuments(query)
    ]);

    res.json({ items, total, limit, skip });
  } catch (err) {
    console.error('Get recommendations error:', err);
    res.status(500).json({ error: 'Failed to load recommendations' });
  }
});

// GET /api/recommendations/sent — list recommendations sent by the current user
router.get('/sent', async (req, res) => {
  try {
    const { limit, offset: skip } = parsePagination(req.query, { limit: 20, maxLimit: 50 });

    const query = { sender: new mongoose.Types.ObjectId(req.user.id) };

    const [items, total] = await Promise.all([
      Recommendation.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('recipient', 'username displayName')
        .populate('wine', 'name producer appellation country region image')
        .lean(),
      Recommendation.countDocuments(query)
    ]);

    res.json({ items, total, limit, skip });
  } catch (err) {
    console.error('Get sent recommendations error:', err);
    res.status(500).json({ error: 'Failed to load sent recommendations' });
  }
});

// POST /api/recommendations — send a recommendation
router.post('/', async (req, res) => {
  try {
    const { wineId, recipientId, recipientEmail, note } = req.body;

    if (!wineId || !isValidId(wineId)) {
      return res.status(400).json({ error: 'Valid wine ID is required' });
    }

    // Must provide either a user ID or an email
    if (!recipientId && !recipientEmail) {
      return res.status(400).json({ error: 'Recipient user or email is required' });
    }

    if (recipientId && !isValidId(recipientId)) {
      return res.status(400).json({ error: 'Invalid recipient ID' });
    }

    if (recipientId && recipientId === req.user.id) {
      return res.status(400).json({ error: 'You cannot recommend a wine to yourself' });
    }

    // Validate note length
    const trimmedNote = (note || '').trim().slice(0, 500);

    // Validate wine exists
    const wine = await WineDefinition.findById(wineId)
      .select('name producer appellation country region image')
      .lean();
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    let recipientUser = null;

    if (recipientId) {
      recipientUser = await User.findById(recipientId).select('username displayName email');
      if (!recipientUser) return res.status(404).json({ error: 'Recipient user not found' });
    } else if (recipientEmail) {
      // Check if the email belongs to an existing user
      const emailTrimmed = recipientEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(emailTrimmed)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      recipientUser = await User.findOne({ email: emailTrimmed }).select('username displayName email');
    }

    const rec = await Recommendation.create({
      sender: req.user.id,
      recipient: recipientUser?._id || null,
      recipientEmail: recipientUser ? null : recipientEmail.trim().toLowerCase(),
      wine: wineId,
      note: trimmedNote
    });

    // Populate for the response
    const populated = await Recommendation.findById(rec._id)
      .populate('sender', 'username displayName')
      .populate('recipient', 'username displayName')
      .populate('wine', 'name producer appellation country region image')
      .lean();

    // Send in-app notification to recipient if they are a user
    if (recipientUser) {
      const senderName = req.user.displayName || req.user.username || 'Someone';
      const wineName = wine.name || 'a wine';
      createNotification(
        recipientUser._id,
        'wine_recommendation',
        'Wine Recommendation',
        `${senderName} recommends "${wineName}"${trimmedNote ? `: "${trimmedNote}"` : ''}`,
        `/recommendations`
      );
    }

    // Send email for external (non-user) recipients
    if (!recipientUser && recipientEmail && EMAIL_VERIFICATION_ENABLED) {
      const senderUser = await User.findById(req.user.id).select('username displayName');
      const senderName = senderUser?.displayName || senderUser?.username || 'A Cellarion user';
      sendRecommendationEmail(
        recipientEmail.trim().toLowerCase(),
        senderName,
        wine,
        trimmedNote
      ).catch(err => console.error('[recommendations] Email send failed:', err.message));
    }

    logAudit(req, 'recommendation.send', {
      type: 'recommendation',
      id: rec._id,
      wineId,
      recipientId: recipientUser?._id || null,
      recipientEmail: recipientUser ? null : recipientEmail
    });

    res.status(201).json({ recommendation: populated });
  } catch (err) {
    console.error('Create recommendation error:', err);
    res.status(500).json({ error: 'Failed to send recommendation' });
  }
});

// PUT /api/recommendations/:id/status — update recommendation status (mark as seen, added to wishlist)
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ error: 'Invalid recommendation ID' });

    const { status } = req.body;
    if (!['seen', 'added-to-wishlist'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "seen" or "added-to-wishlist"' });
    }

    const rec = await Recommendation.findOneAndUpdate(
      { _id: id, recipient: req.user.id },
      { status },
      { new: true }
    )
      .populate('sender', 'username displayName')
      .populate('wine', 'name producer appellation country region image')
      .lean();

    if (!rec) return res.status(404).json({ error: 'Recommendation not found' });

    res.json({ recommendation: rec });
  } catch (err) {
    console.error('Update recommendation status error:', err);
    res.status(500).json({ error: 'Failed to update recommendation' });
  }
});

// DELETE /api/recommendations/:id — delete a received recommendation
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ error: 'Invalid recommendation ID' });

    const rec = await Recommendation.findOneAndDelete({
      _id: id,
      recipient: req.user.id
    });

    if (!rec) return res.status(404).json({ error: 'Recommendation not found' });

    logAudit(req, 'recommendation.delete', {
      type: 'recommendation',
      id: rec._id,
      wineId: rec.wine
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete recommendation error:', err);
    res.status(500).json({ error: 'Failed to delete recommendation' });
  }
});

// GET /api/recommendations/friends — search following list for friend picker
router.get('/friends', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const { limit } = parsePagination(req.query, { limit: 10, maxLimit: 20 });

    // Get users the current user follows
    const follows = await Follow.find({ follower: req.user.id }).select('following').lean();
    const followingIds = follows.map(f => f.following);

    if (followingIds.length === 0) return res.json({ users: [] });

    const filter = { _id: { $in: followingIds } };
    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ username: regex }, { displayName: regex }];
    }

    const users = await User.find(filter)
      .select('username displayName')
      .limit(limit)
      .lean();

    res.json({ users });
  } catch (err) {
    console.error('Friends search error:', err);
    res.status(500).json({ error: 'Failed to search friends' });
  }
});

module.exports = router;
