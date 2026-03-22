const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Follow = require('../models/Follow');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { logAudit } = require('../services/audit');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

const isValidId = (id) => typeof id === 'string' && mongoose.isValidObjectId(id);

// POST /api/follows/:userId - Follow a user
router.post('/:userId', async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (!isValidId(targetId)) return res.status(400).json({ error: 'Invalid user ID' });

    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'You cannot follow yourself' });
    }

    // Verify target user exists
    const target = await User.findById(targetId).select('_id username displayName');
    if (!target) return res.status(404).json({ error: 'User not found' });

    const follow = new Follow({ follower: req.user.id, following: targetId });
    await follow.save();

    // Update counts (fire-and-forget)
    User.updateOne({ _id: req.user.id }, { $inc: { followingCount: 1 } }).catch(() => {});
    User.updateOne({ _id: targetId }, { $inc: { followersCount: 1 } }).catch(() => {});

    // Send notification (fire-and-forget)
    const followerUser = await User.findById(req.user.id).select('username displayName');
    const followerName = followerUser?.displayName || followerUser?.username || 'Someone';
    new Notification({
      user: targetId,
      type: 'new_follower',
      title: 'New Follower',
      message: `${followerName} started following you`,
      link: `/users/${req.user.id}`
    }).save().catch(() => {});

    logAudit(req, 'user.follow', { type: 'user', id: targetId });

    res.status(201).json({ following: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Already following this user' });
    }
    console.error('Follow error:', err);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

// DELETE /api/follows/:userId - Unfollow a user
router.delete('/:userId', async (req, res) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const result = await Follow.deleteOne({ follower: req.user.id, following: req.params.userId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Not following this user' });
    }

    // Update counts (fire-and-forget)
    User.updateOne({ _id: req.user.id }, { $inc: { followingCount: -1 } }).catch(() => {});
    User.updateOne({ _id: req.params.userId }, { $inc: { followersCount: -1 } }).catch(() => {});

    // Prevent negative counts
    User.updateOne({ _id: req.user.id, followingCount: { $lt: 0 } }, { $set: { followingCount: 0 } }).catch(() => {});
    User.updateOne({ _id: req.params.userId, followersCount: { $lt: 0 } }, { $set: { followersCount: 0 } }).catch(() => {});

    logAudit(req, 'user.unfollow', { type: 'user', id: req.params.userId });

    res.json({ following: false });
  } catch (err) {
    console.error('Unfollow error:', err);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

// GET /api/follows/:userId/followers - List followers
router.get('/:userId/followers', async (req, res) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [follows, total] = await Promise.all([
      Follow.find({ following: req.params.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('follower', 'username displayName bio'),
      Follow.countDocuments({ following: req.params.userId })
    ]);

    const users = follows.map(f => f.follower);

    // Check which of these users the current user follows
    const userIds = users.map(u => u._id);
    const myFollows = await Follow.find({ follower: req.user.id, following: { $in: userIds } }).select('following');
    const followingSet = new Set(myFollows.map(f => f.following.toString()));

    const enriched = users.map(u => ({
      ...u.toObject(),
      isFollowing: followingSet.has(u._id.toString())
    }));

    res.json({ users: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Get followers error:', err);
    res.status(500).json({ error: 'Failed to get followers' });
  }
});

// GET /api/follows/:userId/following - List following
router.get('/:userId/following', async (req, res) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [follows, total] = await Promise.all([
      Follow.find({ follower: req.params.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('following', 'username displayName bio'),
      Follow.countDocuments({ follower: req.params.userId })
    ]);

    const users = follows.map(f => f.following);

    // Check which of these users the current user follows
    const userIds = users.map(u => u._id);
    const myFollows = await Follow.find({ follower: req.user.id, following: { $in: userIds } }).select('following');
    const followingSet = new Set(myFollows.map(f => f.following.toString()));

    const enriched = users.map(u => ({
      ...u.toObject(),
      isFollowing: followingSet.has(u._id.toString())
    }));

    res.json({ users: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Get following error:', err);
    res.status(500).json({ error: 'Failed to get following' });
  }
});

module.exports = router;
