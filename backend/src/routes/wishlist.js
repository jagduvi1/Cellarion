const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const WishlistItem = require('../models/WishlistItem');
const { logAudit } = require('../services/audit');

const router = express.Router();

// All wishlist routes require authentication
router.use(requireAuth);

/**
 * GET /api/wishlist
 * List the authenticated user's wishlist items.
 * Query params:
 *   status  – 'wanted' | 'bought' | 'all' (default: 'all')
 *   sort    – 'newest' | 'oldest' | 'name' | 'priority' (default: 'newest')
 *   search  – free-text filter on wine name / producer
 *   limit   – pagination limit (max 100, default 50)
 *   skip    – pagination offset
 */
router.get('/', async (req, res) => {
  try {
    const { status, sort = 'newest', search, limit: rawLimit, skip: rawSkip } = req.query;

    const filter = { user: new mongoose.Types.ObjectId(req.user.id) };
    if (status && status !== 'all') {
      if (!['wanted', 'bought'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      filter.status = status;
    }

    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 100);
    const skip  = Math.max(parseInt(rawSkip, 10) || 0, 0);

    // Build the aggregation so we can filter on populated wine fields
    const pipeline = [
      { $match: filter },
      // Populate wineDefinition
      {
        $lookup: {
          from: 'winedefinitions',
          localField: 'wineDefinition',
          foreignField: '_id',
          as: 'wineDefinition'
        }
      },
      { $unwind: '$wineDefinition' },
      // Populate country
      {
        $lookup: {
          from: 'countries',
          localField: 'wineDefinition.country',
          foreignField: '_id',
          as: 'wineDefinition.country'
        }
      },
      {
        $unwind: {
          path: '$wineDefinition.country',
          preserveNullAndEmptyArrays: true
        }
      },
      // Populate region
      {
        $lookup: {
          from: 'regions',
          localField: 'wineDefinition.region',
          foreignField: '_id',
          as: 'wineDefinition.region'
        }
      },
      {
        $unwind: {
          path: '$wineDefinition.region',
          preserveNullAndEmptyArrays: true
        }
      },
      // Populate grapes
      {
        $lookup: {
          from: 'grapes',
          localField: 'wineDefinition.grapes',
          foreignField: '_id',
          as: 'wineDefinition.grapes'
        }
      }
    ];

    // Free-text search on wine name or producer
    if (search && search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pipeline.push({
        $match: {
          $or: [
            { 'wineDefinition.name': { $regex: escaped, $options: 'i' } },
            { 'wineDefinition.producer': { $regex: escaped, $options: 'i' } }
          ]
        }
      });
    }

    // Sort
    let sortStage;
    switch (sort) {
      case 'oldest':
        sortStage = { createdAt: 1 };
        break;
      case 'name':
        sortStage = { 'wineDefinition.name': 1, createdAt: -1 };
        break;
      case 'priority': {
        // high > medium > low
        pipeline.push({
          $addFields: {
            _priorityOrder: {
              $switch: {
                branches: [
                  { case: { $eq: ['$priority', 'high'] }, then: 0 },
                  { case: { $eq: ['$priority', 'medium'] }, then: 1 },
                  { case: { $eq: ['$priority', 'low'] }, then: 2 }
                ],
                default: 1
              }
            }
          }
        });
        sortStage = { _priorityOrder: 1, createdAt: -1 };
        break;
      }
      default: // newest
        sortStage = { createdAt: -1 };
    }

    pipeline.push({ $sort: sortStage });

    // Count before pagination
    const countPipeline = [...pipeline, { $count: 'total' }];
    const [countResult] = await WishlistItem.aggregate(countPipeline);
    const total = countResult?.total || 0;

    pipeline.push({ $skip: skip }, { $limit: limit });

    // Remove internal sort field
    pipeline.push({ $project: { _priorityOrder: 0 } });

    const items = await WishlistItem.aggregate(pipeline);

    res.json({ items, total, limit, skip });
  } catch (err) {
    console.error('[wishlist] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch wishlist' });
  }
});

/**
 * POST /api/wishlist
 * Add a wine to the authenticated user's wishlist.
 * Body: { wineDefinitionId, vintage?, notes?, priority? }
 */
router.post('/', async (req, res) => {
  try {
    const { wineDefinitionId, vintage, notes, priority } = req.body;

    if (!wineDefinitionId || !mongoose.Types.ObjectId.isValid(wineDefinitionId)) {
      return res.status(400).json({ error: 'Valid wineDefinitionId is required' });
    }

    // Sanitise vintage: must be a string (prevents NoSQL injection via objects)
    const safeVintage = vintage != null ? String(vintage) : '';

    // Prevent duplicates: same user + same wine + same vintage (or both null)
    const dupFilter = {
      user: req.user.id,
      wineDefinition: wineDefinitionId,
      status: 'wanted'
    };
    if (safeVintage) {
      dupFilter.vintage = safeVintage;
    } else {
      dupFilter.$or = [{ vintage: null }, { vintage: { $exists: false } }, { vintage: '' }];
    }
    const existing = await WishlistItem.findOne(dupFilter);
    if (existing) {
      return res.status(409).json({ error: 'This wine is already on your wishlist' });
    }

    // Validate notes length
    if (notes && notes.length > 2000) {
      return res.status(400).json({ error: 'Notes must be 2000 characters or less' });
    }
    // Validate priority
    if (priority && !['low', 'medium', 'high'].includes(priority)) {
      return res.status(400).json({ error: 'Priority must be low, medium, or high' });
    }
    // Validate vintage length
    if (safeVintage && safeVintage.length > 20) {
      return res.status(400).json({ error: 'Vintage must be 20 characters or less' });
    }

    const item = await WishlistItem.create({
      user: req.user.id,
      wineDefinition: wineDefinitionId,
      vintage: safeVintage || undefined,
      notes: notes || undefined,
      priority: priority || 'medium'
    });

    // Populate for response
    const populated = await WishlistItem.findById(item._id)
      .populate({
        path: 'wineDefinition',
        populate: [
          { path: 'country' },
          { path: 'region' },
          { path: 'grapes' }
        ]
      });

    logAudit(req, 'wishlist.add', { wishlistItemId: item._id, wineDefinitionId });

    res.status(201).json({ item: populated });
  } catch (err) {
    console.error('[wishlist] POST / error:', err);
    res.status(500).json({ error: 'Failed to add to wishlist' });
  }
});

/**
 * PUT /api/wishlist/:id
 * Update a wishlist item (notes, priority, status, vintage).
 * Only the owning user can update.
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid wishlist item ID' });
    }

    const item = await WishlistItem.findById(id);
    if (!item) return res.status(404).json({ error: 'Wishlist item not found' });
    if (item.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { notes, priority, status, vintage } = req.body;

    if (notes !== undefined) {
      if (notes.length > 2000) return res.status(400).json({ error: 'Notes must be 2000 characters or less' });
      item.notes = notes;
    }
    if (priority !== undefined) {
      if (!['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
      item.priority = priority;
    }
    if (status !== undefined) {
      if (!['wanted', 'bought'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      if (status === 'bought' && item.status !== 'bought') {
        item.boughtAt = new Date();
      }
      if (status === 'wanted') {
        item.boughtAt = null;
      }
      item.status = status;
    }
    if (vintage !== undefined) {
      const safeVin = String(vintage);
      if (safeVin.length > 20) return res.status(400).json({ error: 'Vintage too long' });
      item.vintage = safeVin;
    }

    await item.save();

    const populated = await WishlistItem.findById(item._id)
      .populate({
        path: 'wineDefinition',
        populate: [
          { path: 'country' },
          { path: 'region' },
          { path: 'grapes' }
        ]
      });

    logAudit(req, 'wishlist.update', { wishlistItemId: id });

    res.json({ item: populated });
  } catch (err) {
    console.error('[wishlist] PUT /:id error:', err);
    res.status(500).json({ error: 'Failed to update wishlist item' });
  }
});

/**
 * DELETE /api/wishlist/:id
 * Remove a wishlist item. Only the owning user can delete.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid wishlist item ID' });
    }

    const item = await WishlistItem.findById(id);
    if (!item) return res.status(404).json({ error: 'Wishlist item not found' });
    if (item.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await item.deleteOne();

    logAudit(req, 'wishlist.remove', { wishlistItemId: id });

    res.json({ message: 'Removed from wishlist' });
  } catch (err) {
    console.error('[wishlist] DELETE /:id error:', err);
    res.status(500).json({ error: 'Failed to remove from wishlist' });
  }
});

module.exports = router;
