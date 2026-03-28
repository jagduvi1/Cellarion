const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireModeratorOrAdmin } = require('../middleware/auth');
const Discussion = require('../models/Discussion');
const { CATEGORIES } = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const DiscussionReplyVote = require('../models/DiscussionReplyVote');
const DiscussionReport = require('../models/DiscussionReport');
const Notification = require('../models/Notification');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const { stripHtml } = require('../utils/sanitize');
const { logAudit } = require('../services/audit');
const { incrementCred } = require('../utils/cellarCred');
const { DISCUSSIONS_PER_PAGE, DISCUSSIONS_MAX_PER_PAGE, DISCUSSION_MAX_LENGTHS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth);

const isValidId = (id) => typeof id === 'string' && mongoose.isValidObjectId(id);

// Check if the requesting user is banned from discussions; returns error response or null
async function checkDiscussionBan(req, res) {
  const u = await User.findById(req.user.id).select('discussionBan');
  if (u && u.isDiscussionBanned()) {
    const ban = u.discussionBan;
    const msg = ban.expiresAt
      ? `You are banned from discussions until ${ban.expiresAt.toISOString()}`
      : 'You are permanently banned from discussions';
    res.status(403).json({ error: msg, banned: true, expiresAt: ban.expiresAt });
    return true;
  }
  return false;
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(DISCUSSIONS_MAX_PER_PAGE, Math.max(1, parseInt(query.limit, 10) || DISCUSSIONS_PER_PAGE));
  return { page, limit, skip: (page - 1) * limit };
}

// GET /api/discussions/categories - Available categories
router.get('/categories', (req, res) => {
  res.json({ categories: CATEGORIES });
});

// GET /api/discussions - List discussions
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { category, sort } = req.query;

    const filter = {};
    if (category && CATEGORIES.includes(category)) {
      filter.category = category;
    }

    let sortObj;
    switch (sort) {
      case 'newest':
        sortObj = { isPinned: -1, createdAt: -1 };
        break;
      case 'most-replies':
        sortObj = { isPinned: -1, replyCount: -1, lastActivityAt: -1 };
        break;
      default: // 'active' - default sort
        sortObj = { isPinned: -1, lastActivityAt: -1 };
    }

    const [discussions, total] = await Promise.all([
      Discussion.find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName roles contribution.tier contribution.specialty')
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }),
      Discussion.countDocuments(filter)
    ]);

    res.json({ discussions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List discussions error:', err);
    res.status(500).json({ error: 'Failed to list discussions' });
  }
});

// ─── Moderation Queue (moderator/admin only) ───────────────────────────────
// These routes MUST be registered before /:id to avoid "moderation" being treated as an ID.

// GET /api/discussions/moderation/reports - List pending reports
router.get('/moderation/reports', requireModeratorOrAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const VALID_STATUSES = ['pending', 'resolved', 'dismissed'];
    const status = VALID_STATUSES.includes(req.query.status) ? req.query.status : 'pending';

    const [reports, total] = await Promise.all([
      DiscussionReport.find({ status })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'username displayName')
        .populate({ path: 'discussion', select: 'title author', populate: { path: 'author', select: 'username displayName' } })
        .populate({ path: 'reply', select: 'body author discussion', populate: { path: 'author', select: 'username displayName' } }),
      DiscussionReport.countDocuments({ status })
    ]);

    res.json({ reports, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List reports error:', err);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// PATCH /api/discussions/moderation/reports/:reportId - Resolve a report
router.patch('/moderation/reports/:reportId', requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.reportId)) return res.status(400).json({ error: 'Invalid report ID' });
    const report = await DiscussionReport.findById(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const { status } = req.body;
    if (!status || !['resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "resolved" or "dismissed"' });
    }

    report.status = status;
    report.resolvedBy = req.user.id;
    report.resolvedAt = new Date();
    await report.save();

    logAudit(req, 'discussion_report.resolve', { type: 'discussion_report', id: report._id }, { status });

    res.json({ report });
  } catch (err) {
    console.error('Resolve report error:', err);
    res.status(500).json({ error: 'Failed to resolve report' });
  }
});

// ─── User Banning (moderator/admin) ─────────────────────────────────────────
// Registered before /:id to avoid "moderation" being treated as an ID.

const BAN_DURATIONS = {
  '10m':  10 * 60 * 1000,
  '1h':   60 * 60 * 1000,
  '1d':   24 * 60 * 60 * 1000,
  '1w':   7 * 24 * 60 * 60 * 1000,
  'permanent': null
};

// POST /api/discussions/moderation/ban - Ban a user from discussions
router.post('/moderation/ban', requireModeratorOrAdmin, async (req, res) => {
  try {
    const { userId, duration, reason } = req.body;
    if (!userId || !isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });
    if (!duration || !Object.prototype.hasOwnProperty.call(BAN_DURATIONS, duration)) {
      return res.status(400).json({ error: `Duration must be one of: ${Object.keys(BAN_DURATIONS).join(', ')}` });
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Don't allow banning other mods/admins
    if (targetUser.roles.includes('moderator') || targetUser.roles.includes('admin')) {
      return res.status(403).json({ error: 'Cannot ban moderators or admins' });
    }

    const durationMs = BAN_DURATIONS[duration];
    targetUser.discussionBan = {
      active: true,
      reason: reason ? stripHtml(reason) : null,
      bannedAt: new Date(),
      expiresAt: durationMs ? new Date(Date.now() + durationMs) : null,
      bannedBy: req.user.id
    };

    await targetUser.save();
    logAudit(req, 'discussion_ban.create', { type: 'user', id: targetUser._id }, { duration, reason });

    res.json({
      message: `User banned for ${duration}`,
      ban: targetUser.discussionBan
    });
  } catch (err) {
    console.error('Ban user error:', err);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// DELETE /api/discussions/moderation/ban/:userId - Unban a user
router.delete('/moderation/ban/:userId', requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    targetUser.discussionBan = {
      active: false,
      reason: null,
      bannedAt: null,
      expiresAt: null,
      bannedBy: null
    };

    await targetUser.save();
    logAudit(req, 'discussion_ban.remove', { type: 'user', id: targetUser._id });

    res.json({ message: 'User unbanned' });
  } catch (err) {
    console.error('Unban user error:', err);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// GET /api/discussions/:id - Single discussion
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });

    const discussion = await Discussion.findById(req.params.id)
      .populate('author', 'username displayName roles contribution.tier contribution.specialty')
      .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } });

    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    res.json({ discussion });
  } catch (err) {
    console.error('Get discussion error:', err);
    res.status(500).json({ error: 'Failed to get discussion' });
  }
});

// POST /api/discussions - Create a discussion
router.post('/', async (req, res) => {
  try {
    if (await checkDiscussionBan(req, res)) return;

    const { title, body, category, wineDefinition } = req.body;

    if (!title || !body || !category) {
      return res.status(400).json({ error: 'Title, body, and category are required' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    if (wineDefinition && !isValidId(wineDefinition)) {
      return res.status(400).json({ error: 'Invalid wine definition ID' });
    }

    const cleanTitle = stripHtml(title);
    const cleanBody = stripHtml(body);

    if (cleanTitle.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters' });
    if (cleanTitle.length > DISCUSSION_MAX_LENGTHS.title) return res.status(400).json({ error: `Title too long (max ${DISCUSSION_MAX_LENGTHS.title} characters)` });
    if (cleanBody.length < 10) return res.status(400).json({ error: 'Body must be at least 10 characters' });
    if (cleanBody.length > DISCUSSION_MAX_LENGTHS.body) return res.status(400).json({ error: `Body too long (max ${DISCUSSION_MAX_LENGTHS.body} characters)` });

    const discussion = new Discussion({
      author: req.user.id,
      title: cleanTitle,
      body: cleanBody,
      category,
      wineDefinition: wineDefinition || null
    });

    await discussion.save();
    incrementCred(req.user.id, 'discussion_created').catch(() => {});
    logAudit(req, 'discussion.create', { type: 'discussion', id: discussion._id }, { title: cleanTitle, category });

    await discussion.populate('author', 'username displayName roles contribution.tier contribution.specialty');

    res.status(201).json({ discussion });
  } catch (err) {
    console.error('Create discussion error:', err);
    res.status(500).json({ error: 'Failed to create discussion' });
  }
});

// PUT /api/discussions/:id - Update own discussion (or moderator/admin)
router.put('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });
    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const isOwner = discussion.author.toString() === req.user.id;
    const isMod = req.user.roles && (req.user.roles.includes('moderator') || req.user.roles.includes('admin'));
    if (!isOwner && !isMod) {
      return res.status(403).json({ error: 'You can only edit your own discussions' });
    }

    const { title, body, category } = req.body;

    if (title !== undefined) {
      const cleanTitle = stripHtml(title);
      if (cleanTitle.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters' });
      if (cleanTitle.length > DISCUSSION_MAX_LENGTHS.title) return res.status(400).json({ error: 'Title too long' });
      discussion.title = cleanTitle;
    }

    if (body !== undefined) {
      const cleanBody = stripHtml(body);
      if (cleanBody.length < 10) return res.status(400).json({ error: 'Body must be at least 10 characters' });
      if (cleanBody.length > DISCUSSION_MAX_LENGTHS.body) return res.status(400).json({ error: 'Body too long' });
      discussion.body = cleanBody;
    }

    if (category !== undefined) {
      if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
      discussion.category = category;
    }

    await discussion.save();
    logAudit(req, 'discussion.update', { type: 'discussion', id: discussion._id });

    await discussion.populate('author', 'username displayName roles contribution.tier contribution.specialty');
    res.json({ discussion });
  } catch (err) {
    console.error('Update discussion error:', err);
    res.status(500).json({ error: 'Failed to update discussion' });
  }
});

// DELETE /api/discussions/:id - Delete discussion (moderator/admin only)
router.delete('/:id', requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });
    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    // Clean up replies and votes
    const replyIds = await DiscussionReply.find({ discussion: discussion._id }).select('_id');
    const replyIdList = replyIds.map(r => r._id);
    DiscussionReplyVote.deleteMany({ reply: { $in: replyIdList } }).catch(() => {});
    DiscussionReply.deleteMany({ discussion: discussion._id }).catch(() => {});
    DiscussionReport.deleteMany({ discussion: discussion._id }).catch(() => {});

    await Discussion.deleteOne({ _id: discussion._id });
    logAudit(req, 'discussion.delete', { type: 'discussion', id: discussion._id });

    res.json({ message: 'Discussion deleted' });
  } catch (err) {
    console.error('Delete discussion error:', err);
    res.status(500).json({ error: 'Failed to delete discussion' });
  }
});

// ─── Replies ────────────────────────────────────────────────────────────────

// GET /api/discussions/:id/replies - List replies for a discussion
router.get('/:id/replies', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });
    const { page, limit, skip } = parsePagination(req.query);

    const [replies, total] = await Promise.all([
      DiscussionReply.find({ discussion: req.params.id })
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName roles contribution.tier contribution.specialty')
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }),
      DiscussionReply.countDocuments({ discussion: req.params.id })
    ]);

    // Check which replies the current user has liked
    const replyIds = replies.map(r => r._id);
    const userVotes = await DiscussionReplyVote.find({ user: req.user.id, reply: { $in: replyIds } }).select('reply');
    const likedSet = new Set(userVotes.map(v => v.reply.toString()));

    const isMod = req.user.roles && (req.user.roles.includes('moderator') || req.user.roles.includes('admin'));
    const enriched = replies.map(r => {
      const obj = r.toObject();
      obj.liked = likedSet.has(r._id.toString());
      // Never leak deletedBody to non-mods
      if (!isMod) delete obj.deletedBody;
      return obj;
    });

    res.json({ replies: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List replies error:', err);
    res.status(500).json({ error: 'Failed to list replies' });
  }
});

// POST /api/discussions/:id/replies - Create a reply
router.post('/:id/replies', async (req, res) => {
  try {
    if (await checkDiscussionBan(req, res)) return;
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });

    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });
    if (discussion.isLocked) {
      return res.status(403).json({ error: 'This discussion is locked' });
    }

    const { body, quote, wineDefinition: wineDefId } = req.body;
    if (!body) return res.status(400).json({ error: 'Reply body is required' });

    const cleanBody = stripHtml(body);
    if (cleanBody.length < 1) return res.status(400).json({ error: 'Reply cannot be empty' });
    if (cleanBody.length > DISCUSSION_MAX_LENGTHS.replyBody) return res.status(400).json({ error: 'Reply too long' });

    // Build quote snapshot if quoting another reply
    let quoteData = {};
    if (quote && quote.replyId && isValidId(quote.replyId)) {
      const quotedReply = await DiscussionReply.findById(quote.replyId).populate('author', 'username displayName');
      if (quotedReply) {
        const quotedName = quotedReply.author?.displayName || quotedReply.author?.username || 'Unknown';
        // Store a truncated snapshot (max 300 chars) so the DB doesn't bloat
        const snippetBody = quotedReply.body.length > 300
          ? quotedReply.body.slice(0, 300) + '…'
          : quotedReply.body;
        quoteData = {
          replyId: quotedReply._id,
          authorName: quotedName,
          body: snippetBody
        };
      }
    }

    // Validate wine reference if provided
    let validWineId = null;
    if (wineDefId && isValidId(wineDefId)) {
      const wine = await WineDefinition.findById(wineDefId).select('_id');
      if (wine) validWineId = wine._id;
    }

    const reply = new DiscussionReply({
      discussion: discussion._id,
      author: req.user.id,
      body: cleanBody,
      quote: quoteData.replyId ? quoteData : undefined,
      wineDefinition: validWineId
    });

    await reply.save();
    incrementCred(req.user.id, 'discussion_reply_created').catch(() => {});

    // Update discussion counters
    Discussion.updateOne(
      { _id: discussion._id },
      { $inc: { replyCount: 1 }, $set: { lastActivityAt: new Date() } }
    ).catch(() => {});

    // Notify the discussion author (if not replying to own thread)
    if (discussion.author.toString() !== req.user.id) {
      const replier = await User.findById(req.user.id).select('username displayName');
      const replierName = replier?.displayName || replier?.username || 'Someone';
      new Notification({
        user: discussion.author,
        type: 'discussion_reply',
        title: 'New reply to your discussion',
        message: `${replierName} replied to "${discussion.title}"`,
        link: `/community/discussions/${discussion._id}`
      }).save().catch(() => {});
    }

    logAudit(req, 'discussion_reply.create', { type: 'discussion_reply', id: reply._id }, { discussion: discussion._id });

    await reply.populate('author', 'username displayName roles contribution.tier contribution.specialty');
    await reply.populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } });

    res.status(201).json({ reply });
  } catch (err) {
    console.error('Create reply error:', err);
    res.status(500).json({ error: 'Failed to create reply' });
  }
});

// PUT /api/discussions/:discussionId/replies/:replyId - Update own reply
router.put('/:discussionId/replies/:replyId', async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const reply = await DiscussionReply.findById(req.params.replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    const isOwner = reply.author.toString() === req.user.id;
    const isMod = req.user.roles && (req.user.roles.includes('moderator') || req.user.roles.includes('admin'));
    if (!isOwner && !isMod) {
      return res.status(403).json({ error: 'You can only edit your own replies' });
    }

    const { body } = req.body;
    if (body !== undefined) {
      const cleanBody = stripHtml(body);
      if (cleanBody.length < 1) return res.status(400).json({ error: 'Reply cannot be empty' });
      if (cleanBody.length > DISCUSSION_MAX_LENGTHS.replyBody) return res.status(400).json({ error: 'Reply too long' });
      reply.body = cleanBody;
    }

    await reply.save();
    logAudit(req, 'discussion_reply.update', { type: 'discussion_reply', id: reply._id });

    await reply.populate('author', 'username displayName roles contribution.tier contribution.specialty');
    res.json({ reply });
  } catch (err) {
    console.error('Update reply error:', err);
    res.status(500).json({ error: 'Failed to update reply' });
  }
});

// DELETE /api/discussions/:discussionId/replies/:replyId - Soft-delete reply (user or mod/admin)
router.delete('/:discussionId/replies/:replyId', async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const reply = await DiscussionReply.findById(req.params.replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    if (reply.isDeleted) return res.status(400).json({ error: 'Reply already deleted' });

    const isOwner = reply.author.toString() === req.user.id;
    const isMod = req.user.roles && (req.user.roles.includes('moderator') || req.user.roles.includes('admin'));
    if (!isOwner && !isMod) {
      return res.status(403).json({ error: 'You can only delete your own replies' });
    }

    // Soft-delete: stash original body, replace with placeholder
    reply.deletedBody = reply.body;
    reply.body = '[This reply has been removed]';
    reply.isDeleted = true;
    reply.deletedAt = new Date();
    await reply.save();

    logAudit(req, 'discussion_reply.soft_delete', { type: 'discussion_reply', id: reply._id });

    res.json({ message: 'Reply deleted', reply: reply.toObject() });
  } catch (err) {
    console.error('Delete reply error:', err);
    res.status(500).json({ error: 'Failed to delete reply' });
  }
});

// GET /api/discussions/:discussionId/replies/:replyId/original - View original text of deleted reply (mod/admin)
router.get('/:discussionId/replies/:replyId/original', requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const reply = await DiscussionReply.findById(req.params.replyId).select('deletedBody isDeleted');
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    if (!reply.isDeleted) return res.status(400).json({ error: 'Reply is not deleted' });

    res.json({ originalBody: reply.deletedBody });
  } catch (err) {
    console.error('Get original reply error:', err);
    res.status(500).json({ error: 'Failed to get original reply' });
  }
});

// POST /api/discussions/:discussionId/replies/:replyId/like - Toggle like on reply
router.post('/:discussionId/replies/:replyId/like', async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const reply = await DiscussionReply.findById(req.params.replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    // Cannot like your own reply
    if (reply.author.toString() === req.user.id) {
      return res.status(400).json({ error: 'Cannot like your own reply' });
    }

    const existing = await DiscussionReplyVote.findOne({ user: req.user.id, reply: reply._id });

    if (existing) {
      await DiscussionReplyVote.deleteOne({ _id: existing._id });
      await DiscussionReply.updateOne({ _id: reply._id }, { $inc: { likesCount: -1 } });
      res.json({ liked: false, likesCount: Math.max(0, reply.likesCount - 1) });
    } else {
      await new DiscussionReplyVote({ user: req.user.id, reply: reply._id }).save();
      await DiscussionReply.updateOne({ _id: reply._id }, { $inc: { likesCount: 1 } });
      incrementCred(reply.author.toString(), 'reply_like_received').catch(() => {});
      res.json({ liked: true, likesCount: reply.likesCount + 1 });
    }
  } catch (err) {
    console.error('Toggle reply like error:', err);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

// ─── Moderation ─────────────────────────────────────────────────────────────

// PATCH /api/discussions/:id/pin - Toggle pin (moderator/admin only)
router.patch('/:id/pin', requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });
    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    discussion.isPinned = !discussion.isPinned;
    await discussion.save();
    logAudit(req, 'discussion.pin', { type: 'discussion', id: discussion._id }, { isPinned: discussion.isPinned });

    res.json({ discussion });
  } catch (err) {
    console.error('Toggle pin error:', err);
    res.status(500).json({ error: 'Failed to toggle pin' });
  }
});

// PATCH /api/discussions/:id/lock - Toggle lock (moderator/admin only)
router.patch('/:id/lock', requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });
    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    discussion.isLocked = !discussion.isLocked;
    await discussion.save();
    logAudit(req, 'discussion.lock', { type: 'discussion', id: discussion._id }, { isLocked: discussion.isLocked });

    res.json({ discussion });
  } catch (err) {
    console.error('Toggle lock error:', err);
    res.status(500).json({ error: 'Failed to toggle lock' });
  }
});

// PATCH /api/discussions/:id/move - Move to different category (moderator/admin only)
router.patch('/:id/move', requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });
    const { category } = req.body;
    if (!category || !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const oldCategory = discussion.category;
    discussion.category = category;
    await discussion.save();
    logAudit(req, 'discussion.move', { type: 'discussion', id: discussion._id }, { from: oldCategory, to: category });

    res.json({ discussion });
  } catch (err) {
    console.error('Move discussion error:', err);
    res.status(500).json({ error: 'Failed to move discussion' });
  }
});

// ─── Reporting ──────────────────────────────────────────────────────────────

// POST /api/discussions/:id/report - Report a discussion
router.post('/:id/report', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid discussion ID' });

    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const VALID_REASONS = ['spam', 'harassment', 'off_topic', 'inappropriate', 'other'];
    const { reason, details } = req.body;
    if (!reason || !VALID_REASONS.includes(String(reason))) {
      return res.status(400).json({ error: 'Valid reason is required (spam, harassment, off_topic, inappropriate, other)' });
    }

    const report = new DiscussionReport({
      user: req.user.id,
      discussion: discussion._id,
      reason: String(reason),
      details: details ? stripHtml(details) : undefined
    });

    await report.save();
    logAudit(req, 'discussion_report.create', { type: 'discussion_report', id: report._id });

    res.status(201).json({ message: 'Report submitted' });
  } catch (err) {
    console.error('Report discussion error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// POST /api/discussions/:discussionId/replies/:replyId/report - Report a reply
router.post('/:discussionId/replies/:replyId/report', async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });

    const reply = await DiscussionReply.findById(req.params.replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    const VALID_REASONS = ['spam', 'harassment', 'off_topic', 'inappropriate', 'other'];
    const { reason, details } = req.body;
    if (!reason || !VALID_REASONS.includes(String(reason))) {
      return res.status(400).json({ error: 'Valid reason is required (spam, harassment, off_topic, inappropriate, other)' });
    }

    const report = new DiscussionReport({
      user: req.user.id,
      reply: reply._id,
      reason: String(reason),
      details: details ? stripHtml(details) : undefined
    });

    await report.save();
    logAudit(req, 'discussion_report.create', { type: 'discussion_report', id: report._id });

    res.status(201).json({ message: 'Report submitted' });
  } catch (err) {
    console.error('Report reply error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

module.exports = router;
