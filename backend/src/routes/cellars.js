const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getPlanConfig } = require('../config/plans');

const router = express.Router();

// Resolve the requesting user's personal color preference for a cellar
function getUserColor(cellar, userId) {
  const entry = cellar.userColors?.find(uc => uc.user.toString() === userId.toString());
  return entry?.color || null;
}

// Statuses that mean a bottle has been removed from the active cellar
const CONSUMED_STATUSES = ['drank', 'gifted', 'sold', 'other'];

// All routes require authentication
router.use(requireAuth);

// GET /api/cellars - List user's cellars (owned + shared)
router.get('/', async (req, res) => {
  try {
    const cellars = await Cellar.find({
      $or: [{ user: req.user.id }, { 'members.user': req.user.id }],
      deletedAt: null
    }).sort({ createdAt: -1 });

    // Inject the requesting user's role + personal color into each cellar object
    const cellarsWithRole = cellars.map(c => {
      const obj = c.toObject();
      obj.userRole = getCellarRole(c, req.user.id);
      obj.userColor = getUserColor(c, req.user.id);
      return obj;
    });

    res.json({ count: cellarsWithRole.length, cellars: cellarsWithRole });
  } catch (error) {
    console.error('Get cellars error:', error);
    res.status(500).json({ error: 'Failed to get cellars' });
  }
});

// POST /api/cellars - Create cellar
router.post('/', async (req, res) => {
  try {
    const { name, description, color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Cellar name is required' });
    }

    // Enforce plan cellar limit
    const planConfig = getPlanConfig(req.user.plan);
    if (planConfig.maxCellars !== -1) {
      const cellarCount = await Cellar.countDocuments({ user: req.user.id, deletedAt: null });
      if (cellarCount >= planConfig.maxCellars) {
        return res.status(403).json({
          error: `Your ${req.user.plan} plan allows a maximum of ${planConfig.maxCellars} cellar${planConfig.maxCellars === 1 ? '' : 's'}.`,
          limitReached: 'cellars',
          limit: planConfig.maxCellars,
          currentPlan: req.user.plan,
        });
      }
    }

    const cellar = new Cellar({
      name: name.trim(),
      description: description?.trim() || '',
      userColors: color ? [{ user: req.user.id, color }] : [],
      user: req.user.id
    });

    await cellar.save();
    const obj = cellar.toObject();
    obj.userRole = 'owner';
    obj.userColor = getUserColor(cellar, req.user.id);
    res.status(201).json({ cellar: obj });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'You already have a cellar with this name' });
    }
    console.error('Create cellar error:', error);
    res.status(500).json({ error: 'Failed to create cellar' });
  }
});

// GET /api/cellars/:id/statistics - Get cellar statistics (active bottles only)
router.get('/:id/statistics', async (req, res) => {
  try {
    const cellar = await Cellar.findById(req.params.id);
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    // Only count active bottles in statistics
    const bottles = await Bottle.find({
      cellar: req.params.id,
      status: { $nin: CONSUMED_STATUSES }
    }).populate({
      path: 'wineDefinition',
      populate: ['country', 'region', 'grapes']
    });

    // Calculate statistics
    const stats = {
      totalBottles: bottles.length,
      uniqueWines: new Set(bottles.map(b => b.wineDefinition?._id.toString())).size,
      totalValue: 0,
      averagePrice: 0,
      byCountry: {},
      byType: {},
      byVintage: {},
      byRating: {},
      oldestVintage: null,
      newestVintage: null
    };

    let priceCount = 0;
    let priceSum = 0;
    let oldestYear = Infinity;
    let newestYear = -Infinity;

    bottles.forEach(bottle => {
      // Total value calculation
      if (bottle.price) {
        stats.totalValue += bottle.price;
        priceSum += bottle.price;
        priceCount++;
      }

      // By country
      const countryName = bottle.wineDefinition?.country?.name || 'Unknown';
      stats.byCountry[countryName] = (stats.byCountry[countryName] || 0) + 1;

      // By type
      const type = bottle.wineDefinition?.type || 'Unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;

      // By vintage
      const vintage = bottle.vintage || 'NV';
      stats.byVintage[vintage] = (stats.byVintage[vintage] || 0) + 1;

      // Track oldest/newest vintage
      if (vintage !== 'NV') {
        const year = parseInt(vintage);
        if (!isNaN(year)) {
          if (year < oldestYear) oldestYear = year;
          if (year > newestYear) newestYear = year;
        }
      }

      // By rating
      if (bottle.rating) {
        const ratingKey = `${bottle.rating} stars`;
        stats.byRating[ratingKey] = (stats.byRating[ratingKey] || 0) + 1;
      }
    });

    stats.averagePrice = priceCount > 0 ? priceSum / priceCount : 0;
    stats.oldestVintage = oldestYear !== Infinity ? oldestYear : null;
    stats.newestVintage = newestYear !== -Infinity ? newestYear : null;

    // Drink window summary counts
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const msPerDay = 86400000;
    let drinkOverdue = 0, drinkSoon = 0;
    bottles.forEach(bottle => {
      if (!bottle.drinkBefore) return;
      const daysLeft = Math.round((new Date(bottle.drinkBefore) - now) / msPerDay);
      if (daysLeft < 0) drinkOverdue++;
      else if (daysLeft <= 90) drinkSoon++;
    });
    stats.drinkOverdue = drinkOverdue;
    stats.drinkSoon = drinkSoon;

    // Round values
    stats.totalValue = Math.round(stats.totalValue * 100) / 100;
    stats.averagePrice = Math.round(stats.averagePrice * 100) / 100;

    res.json({ statistics: stats });
  } catch (error) {
    console.error('Get cellar statistics error:', error);
    res.status(500).json({ error: 'Failed to get cellar statistics' });
  }
});

// GET /api/cellars/:id/history - Get consumed/gifted/sold bottles for this cellar
router.get('/:id/history', async (req, res) => {
  try {
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username');
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) return res.status(404).json({ error: 'Cellar not found' });

    const bottles = await Bottle.find({
      cellar: req.params.id,
      status: { $in: CONSUMED_STATUSES }
    })
      .populate({ path: 'wineDefinition', populate: ['country', 'region', 'grapes'] })
      .sort({ consumedAt: -1 });

    const cellarObj = cellar.toObject();
    cellarObj.userRole = role;
    cellarObj.userColor = getUserColor(cellar, req.user.id);
    res.json({ cellar: cellarObj, bottles });
  } catch (error) {
    console.error('Get cellar history error:', error);
    res.status(500).json({ error: 'Failed to get cellar history' });
  }
});

// GET /api/cellars/:id/members - List members (owner only)
router.get('/:id/members', async (req, res) => {
  try {
    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null })
      .populate('members.user', 'username email');
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    res.json({ members: cellar.members });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// GET /api/cellars/:id - Get cellar details with bottles (active only, with filtering)
router.get('/:id', async (req, res) => {
  try {
    // Populate owner username so shared users can display "Shared by X"
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username');
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    // Base filter: only active bottles
    const filter = {
      cellar: req.params.id,
      status: { $nin: CONSUMED_STATUSES }
    };

    const {
      country,
      region,
      grapes,
      vintage,
      minRating,
      maxRating,
      search,
      drinkStatus,
      sort = '-createdAt'
    } = req.query;

    // Get all active bottles with wine definitions for filtering
    let bottles = await Bottle.find(filter).populate({
      path: 'wineDefinition',
      populate: ['country', 'region', 'grapes']
    });

    // Apply filters on populated data
    if (country) {
      bottles = bottles.filter(b =>
        b.wineDefinition && b.wineDefinition.country &&
        b.wineDefinition.country._id.toString() === country
      );
    }

    if (region) {
      bottles = bottles.filter(b =>
        b.wineDefinition && b.wineDefinition.region &&
        b.wineDefinition.region._id.toString() === region
      );
    }

    if (grapes) {
      const grapeIds = grapes.split(',');
      bottles = bottles.filter(b => {
        if (!b.wineDefinition || !b.wineDefinition.grapes) return false;
        return grapeIds.every(grapeId =>
          b.wineDefinition.grapes.some(g => g._id.toString() === grapeId)
        );
      });
    }

    if (vintage) {
      bottles = bottles.filter(b => b.vintage === vintage);
    }

    if (minRating) {
      const min = parseFloat(minRating);
      bottles = bottles.filter(b => b.rating && b.rating >= min);
    }

    if (maxRating) {
      const max = parseFloat(maxRating);
      bottles = bottles.filter(b => b.rating && b.rating <= max);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      bottles = bottles.filter(b => {
        const wineName = b.wineDefinition?.name?.toLowerCase() || '';
        const producer = b.wineDefinition?.producer?.toLowerCase() || '';
        const notes = b.notes?.toLowerCase() || '';
        const location = b.location?.toLowerCase() || '';
        return wineName.includes(searchLower) ||
               producer.includes(searchLower) ||
               notes.includes(searchLower) ||
               location.includes(searchLower);
      });
    }

    // Filter by drink window status
    if (drinkStatus) {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const msPerDay = 86400000;
      bottles = bottles.filter(b => {
        const before = b.drinkBefore ? new Date(b.drinkBefore) : null;
        const from = b.drinkFrom ? new Date(b.drinkFrom) : null;
        if (!before && !from) return false; // no dates set — excluded from all named statuses
        if (before) {
          const daysLeft = Math.round((before - now) / msPerDay);
          if (daysLeft < 0) return drinkStatus === 'overdue';
          if (daysLeft <= 90) return drinkStatus === 'soon';
        }
        if (from && now < from) return drinkStatus === 'notReady';
        return drinkStatus === 'inWindow';
      });
    }

    // Apply sorting
    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    const sortDir = sort.startsWith('-') ? -1 : 1;

    bottles.sort((a, b) => {
      let aVal, bVal;

      if (sortField === 'vintage') {
        aVal = a.vintage === 'NV' ? '0' : a.vintage;
        bVal = b.vintage === 'NV' ? '0' : b.vintage;
      } else if (sortField === 'rating') {
        aVal = a.rating || 0;
        bVal = b.rating || 0;
      } else if (sortField === 'price') {
        aVal = a.price || 0;
        bVal = b.price || 0;
      } else if (sortField === 'name') {
        aVal = a.wineDefinition?.name || '';
        bVal = b.wineDefinition?.name || '';
      } else {
        // Default to createdAt
        aVal = a.createdAt;
        bVal = b.createdAt;
      }

      if (aVal < bVal) return -sortDir;
      if (aVal > bVal) return sortDir;
      return 0;
    });

    const cellarObj = cellar.toObject();
    cellarObj.userRole = role;
    cellarObj.userColor = getUserColor(cellar, req.user.id);

    res.json({
      cellar: cellarObj,
      bottles: {
        count: bottles.length,
        items: bottles
      }
    });
  } catch (error) {
    console.error('Get cellar error:', error);
    res.status(500).json({ error: 'Failed to get cellar' });
  }
});

// PUT /api/cellars/:id - Update cellar (owner only)
router.put('/:id', async (req, res) => {
  try {
    const { name, description } = req.body;

    const cellar = await Cellar.findOne({
      _id: req.params.id,
      user: req.user.id,
      deletedAt: null
    });

    if (!cellar) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    if (name) cellar.name = name.trim();
    if (description !== undefined) cellar.description = description?.trim() || '';

    await cellar.save();
    const obj = cellar.toObject();
    obj.userRole = 'owner';
    obj.userColor = getUserColor(cellar, req.user.id);
    res.json({ cellar: obj });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'You already have a cellar with this name' });
    }
    console.error('Update cellar error:', error);
    res.status(500).json({ error: 'Failed to update cellar' });
  }
});

// PATCH /api/cellars/:id/color - Set personal color preference (any role)
router.patch('/:id/color', async (req, res) => {
  try {
    const { color } = req.body; // hex string or null/empty to clear
    const cellar = await Cellar.findById(req.params.id);
    const role = getCellarRole(cellar, req.user.id);
    if (!role) return res.status(404).json({ error: 'Cellar not found' });

    const idx = cellar.userColors.findIndex(
      uc => uc.user.toString() === req.user.id.toString()
    );
    if (color) {
      if (idx >= 0) {
        cellar.userColors[idx].color = color;
      } else {
        cellar.userColors.push({ user: req.user.id, color });
      }
    } else {
      if (idx >= 0) cellar.userColors.splice(idx, 1);
    }

    await cellar.save();
    res.json({ userColor: color || null });
  } catch (error) {
    console.error('Set cellar color error:', error);
    res.status(500).json({ error: 'Failed to set color' });
  }
});

// DELETE /api/cellars/:id - Soft-delete cellar (owner only); data retained 30 days
router.delete('/:id', async (req, res) => {
  try {
    const cellar = await Cellar.findOne({
      _id: req.params.id,
      user: req.user.id,
      deletedAt: null
    });

    if (!cellar) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    const now = new Date();
    cellar.deletedAt = now;
    await cellar.save();

    // Cascade soft-delete to all racks in this cellar
    await Rack.updateMany({ cellar: cellar._id }, { deletedAt: now });

    // Bottles are preserved — they remain in history via their status field

    logAudit(req, 'cellar.delete',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { name: cellar.name }
    );

    res.json({ message: 'Cellar deleted' });
  } catch (error) {
    console.error('Delete cellar error:', error);
    res.status(500).json({ error: 'Failed to delete cellar' });
  }
});

// POST /api/cellars/:id/members - Add a member (owner only)
router.post('/:id/members', async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' });
    }
    if (!['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer or editor' });
    }

    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    // Enforce plan share limit
    const planConfig = getPlanConfig(req.user.plan);
    if (planConfig.maxSharesPerCellar !== -1 && cellar.members.length >= planConfig.maxSharesPerCellar) {
      return res.status(403).json({
        error: `Your ${req.user.plan} plan allows a maximum of ${planConfig.maxSharesPerCellar} shared member${planConfig.maxSharesPerCellar === 1 ? '' : 's'} per cellar.`,
        limitReached: 'shares',
        limit: planConfig.maxSharesPerCellar,
        currentPlan: req.user.plan,
      });
    }

    // Look up user by email
    const userToAdd = await User.findOne({ email: email.toLowerCase().trim() });
    if (!userToAdd) {
      return res.status(404).json({ error: 'No user found with that email address' });
    }

    // Can't share with yourself
    if (userToAdd._id.toString() === req.user.id.toString()) {
      return res.status(400).json({ error: 'Cannot share a cellar with yourself' });
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
    const { role } = req.body;
    if (!role || !['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer or editor' });
    }

    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const member = cellar.members.find(m => m.user.toString() === req.params.userId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const previousRole = member.role;
    member.role = role;
    await cellar.save();

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

// GET /api/cellars/:id/audit - Per-cellar audit log (owner only)
router.get('/:id/audit', async (req, res) => {
  try {
    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id });
    if (!cellar) return res.status(403).json({ error: 'Not authorized' });

    const logs = await AuditLog.find({ 'resource.cellarId': req.params.id })
      .sort({ timestamp: -1 })
      .limit(100)
      .populate('actor.userId', 'username email');

    res.json({ logs });
  } catch (error) {
    console.error('Get cellar audit error:', error);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

module.exports = router;
