const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Review = require('../models/Review');
const ReviewVote = require('../models/ReviewVote');
const WineDefinition = require('../models/WineDefinition');
const User = require('../models/User');
const Follow = require('../models/Follow');
const { resolveRating } = require('../utils/ratingUtils');
const { stripHtml } = require('../utils/sanitize');
const { logAudit } = require('../services/audit');
const { updateWineCommunityRating } = require('../services/reviewAggregation');
const { REVIEWS_PER_PAGE, REVIEWS_MAX_PER_PAGE, REVIEW_MAX_LENGTHS } = require('../config/constants');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Helper: validate MongoDB ObjectId
const isValidId = (id) => typeof id === 'string' && mongoose.isValidObjectId(id);

// Helper: parse pagination params
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(REVIEWS_MAX_PER_PAGE, Math.max(1, parseInt(query.limit, 10) || REVIEWS_PER_PAGE));
  return { page, limit, skip: (page - 1) * limit };
}

// Helper: sanitize tasting notes
function sanitizeTasting(tasting) {
  if (!tasting) return {};
  const result = {};
  for (const field of ['aroma', 'palate', 'finish', 'overall']) {
    if (tasting[field]) {
      const cleaned = stripHtml(tasting[field]);
      if (cleaned.length > REVIEW_MAX_LENGTHS[field]) {
        return { error: `${field} notes too long (max ${REVIEW_MAX_LENGTHS[field]} characters)` };
      }
      result[field] = cleaned;
    }
  }
  return result;
}

// POST /api/reviews - Create a review
router.post('/', async (req, res) => {
  try {
    const { wineDefinition, bottle, vintage, rating, ratingScale, tasting } = req.body;

    if (!wineDefinition || !isValidId(wineDefinition)) {
      return res.status(400).json({ error: 'Valid wine definition ID is required' });
    }
    if (bottle && !isValidId(bottle)) {
      return res.status(400).json({ error: 'Invalid bottle ID' });
    }

    // Validate wine exists
    const wine = await WineDefinition.findById(wineDefinition);
    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    // Validate rating
    const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } = resolveRating(rating, ratingScale);
    if (ratingError) return res.status(400).json({ error: ratingError });
    if (resolvedRating == null) return res.status(400).json({ error: 'Rating is required' });

    // Sanitize tasting notes
    const cleanTasting = sanitizeTasting(tasting);
    if (cleanTasting.error) return res.status(400).json({ error: cleanTasting.error });

    const review = new Review({
      author: req.user.id,
      wineDefinition,
      bottle: bottle || null,
      vintage: vintage || null,
      rating: resolvedRating,
      ratingScale: resolvedScale,
      tasting: cleanTasting
    });

    await review.save();

    // Fire-and-forget: update counts
    User.updateOne({ _id: req.user.id }, { $inc: { reviewCount: 1 } }).catch(() => {});
    updateWineCommunityRating(new mongoose.Types.ObjectId(wineDefinition));

    logAudit(req, 'review.create', { type: 'review', id: review._id }, { wineDefinition, rating: resolvedRating });

    // Populate for response
    await review.populate([
      { path: 'author', select: 'username displayName' },
      { path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }
    ]);

    res.status(201).json({ review });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'You have already reviewed this wine. Edit your existing review instead.' });
    }
    console.error('Create review error:', err);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// GET /api/reviews/wine/:wineId - Reviews for a wine
router.get('/wine/:wineId', async (req, res) => {
  try {
    if (!isValidId(req.params.wineId)) return res.status(400).json({ error: 'Invalid wine ID' });
    const { page, limit, skip } = parsePagination(req.query);

    const [reviews, total] = await Promise.all([
      Review.find({ wineDefinition: req.params.wineId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName'),
      Review.countDocuments({ wineDefinition: req.params.wineId })
    ]);

    // Check which reviews the current user has liked
    const reviewIds = reviews.map(r => r._id);
    const userVotes = await ReviewVote.find({ user: req.user.id, review: { $in: reviewIds } }).select('review');
    const likedSet = new Set(userVotes.map(v => v.review.toString()));

    const enriched = reviews.map(r => ({
      ...r.toObject(),
      liked: likedSet.has(r._id.toString())
    }));

    res.json({ reviews: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Get wine reviews error:', err);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// GET /api/reviews/user/:userId - Reviews by a user
router.get('/user/:userId', async (req, res) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const { page, limit, skip } = parsePagination(req.query);

    const [reviews, total] = await Promise.all([
      Review.find({ author: req.params.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }),
      Review.countDocuments({ author: req.params.userId })
    ]);

    // Check which reviews the current user has liked
    const reviewIds = reviews.map(r => r._id);
    const userVotes = await ReviewVote.find({ user: req.user.id, review: { $in: reviewIds } }).select('review');
    const likedSet = new Set(userVotes.map(v => v.review.toString()));

    const enriched = reviews.map(r => ({
      ...r.toObject(),
      liked: likedSet.has(r._id.toString())
    }));

    res.json({ reviews: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Get user reviews error:', err);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// GET /api/reviews/feed - Reviews from followed users
router.get('/feed', async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    // Get list of users the current user follows
    const follows = await Follow.find({ follower: req.user.id }).select('following');
    const followingIds = follows.map(f => f.following);

    // Include own reviews in feed
    followingIds.push(new mongoose.Types.ObjectId(req.user.id));

    const [reviews, total] = await Promise.all([
      Review.find({ author: { $in: followingIds } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName')
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }),
      Review.countDocuments({ author: { $in: followingIds } })
    ]);

    // Check which reviews the current user has liked
    const reviewIds = reviews.map(r => r._id);
    const userVotes = await ReviewVote.find({ user: req.user.id, review: { $in: reviewIds } }).select('review');
    const likedSet = new Set(userVotes.map(v => v.review.toString()));

    const enriched = reviews.map(r => ({
      ...r.toObject(),
      liked: likedSet.has(r._id.toString())
    }));

    res.json({ reviews: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Get review feed error:', err);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// GET /api/reviews/discover - All recent reviews from public profiles
router.get('/discover', async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    // Find users with public profiles
    const publicUsers = await User.find({ profileVisibility: 'public' }).select('_id');
    const publicIds = publicUsers.map(u => u._id);

    const [reviews, total] = await Promise.all([
      Review.find({ author: { $in: publicIds } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName')
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }),
      Review.countDocuments({ author: { $in: publicIds } })
    ]);

    // Check which reviews the current user has liked
    const reviewIds = reviews.map(r => r._id);
    const userVotes = await ReviewVote.find({ user: req.user.id, review: { $in: reviewIds } }).select('review');
    const likedSet = new Set(userVotes.map(v => v.review.toString()));

    const enriched = reviews.map(r => ({
      ...r.toObject(),
      liked: likedSet.has(r._id.toString())
    }));

    res.json({ reviews: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Get discover feed error:', err);
    res.status(500).json({ error: 'Failed to get discover feed' });
  }
});

// GET /api/reviews/:id - Single review
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid review ID' });
    const review = await Review.findById(req.params.id)
      .populate('author', 'username displayName')
      .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } });

    if (!review) return res.status(404).json({ error: 'Review not found' });

    const vote = await ReviewVote.findOne({ user: req.user.id, review: review._id });

    res.json({ review: { ...review.toObject(), liked: !!vote } });
  } catch (err) {
    console.error('Get review error:', err);
    res.status(500).json({ error: 'Failed to get review' });
  }
});

// PUT /api/reviews/:id - Update own review
router.put('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid review ID' });
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.author.toString() !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own reviews' });
    }

    const { rating, ratingScale, tasting, vintage } = req.body;

    // Validate rating if provided
    if (rating !== undefined) {
      const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } = resolveRating(rating, ratingScale);
      if (ratingError) return res.status(400).json({ error: ratingError });
      if (resolvedRating == null) return res.status(400).json({ error: 'Rating is required' });
      review.rating = resolvedRating;
      review.ratingScale = resolvedScale;
    }

    // Sanitize tasting notes if provided
    if (tasting !== undefined) {
      const cleanTasting = sanitizeTasting(tasting);
      if (cleanTasting.error) return res.status(400).json({ error: cleanTasting.error });
      review.tasting = cleanTasting;
    }

    if (vintage !== undefined) review.vintage = vintage;

    await review.save();

    // Fire-and-forget: recalculate community rating
    updateWineCommunityRating(review.wineDefinition);

    logAudit(req, 'review.update', { type: 'review', id: review._id });

    await review.populate([
      { path: 'author', select: 'username displayName' },
      { path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }
    ]);

    res.json({ review });
  } catch (err) {
    console.error('Update review error:', err);
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// DELETE /api/reviews/:id - Delete own review (or admin)
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid review ID' });
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });

    const isOwner = review.author.toString() === req.user.id;
    const isAdmin = req.user.roles && req.user.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own reviews' });
    }

    const wineId = review.wineDefinition;
    const authorId = review.author;

    await Review.deleteOne({ _id: review._id });
    // Clean up votes for this review
    ReviewVote.deleteMany({ review: review._id }).catch(() => {});
    // Update counts
    User.updateOne({ _id: authorId }, { $inc: { reviewCount: -1 } }).catch(() => {});
    updateWineCommunityRating(wineId);

    logAudit(req, 'review.delete', { type: 'review', id: review._id });

    res.json({ message: 'Review deleted' });
  } catch (err) {
    console.error('Delete review error:', err);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// POST /api/reviews/:id/like - Toggle like
router.post('/:id/like', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid review ID' });
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });

    const existing = await ReviewVote.findOne({ user: req.user.id, review: review._id });

    if (existing) {
      await ReviewVote.deleteOne({ _id: existing._id });
      await Review.updateOne({ _id: review._id }, { $inc: { likesCount: -1 } });
      res.json({ liked: false, likesCount: Math.max(0, review.likesCount - 1) });
    } else {
      await new ReviewVote({ user: req.user.id, review: review._id }).save();
      await Review.updateOne({ _id: review._id }, { $inc: { likesCount: 1 } });
      res.json({ liked: true, likesCount: review.likesCount + 1 });
    }
  } catch (err) {
    console.error('Toggle like error:', err);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

module.exports = router;
