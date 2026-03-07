const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getSnapshotsForDates, getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
const { createNotification } = require('../services/notifications');
const { getPlanConfig } = require('../config/plans');
const { toNormalized } = require('../utils/ratingUtils');
const { CONSUMED_STATUSES, MS_PER_DAY } = require('../config/constants');

const router = express.Router();

// Resolve the requesting user's personal color preference for a cellar
function getUserColor(cellar, userId) {
  const entry = cellar.userColors?.find(uc => uc.user.toString() === userId.toString());
  return entry?.color || null;
}

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

    // Batch-load historical rate snapshots for all priceSetAt dates (one DB query)
    const targetCurrency = req.query.currency || null;
    let snapshotMap = new Map();
    let todaySnapshot = null;
    if (targetCurrency) {
      const priceDates = [...new Set(
        bottles
          .filter(b => b.price && b.priceSetAt)
          .map(b => b.priceSetAt.toISOString().slice(0, 10))
      )];
      if (priceDates.length > 0) {
        snapshotMap = await getSnapshotsForDates(priceDates);
      }
      // Fetch today's snapshot as fallback for bottles without priceSetAt
      todaySnapshot = await getOrCreateDailySnapshot();
    }

    // Calculate statistics
    const stats = {
      totalBottles: bottles.length,
      uniqueWines: new Set(bottles.map(b => b.wineDefinition?._id.toString())).size,
      totalValue: 0,
      averagePrice: 0,
      convertedTotal: 0,
      convertedAverage: 0,
      convertedCurrency: targetCurrency,
      byCountry: {},
      byType: {},
      byVintage: {},
      byRating: {},
      oldestVintage: null,
      newestVintage: null
    };

    let priceCount = 0;
    let priceSum = 0;
    let convertedSum = 0;
    let convertedCount = 0;
    let oldestYear = Infinity;
    let newestYear = -Infinity;

    bottles.forEach(bottle => {
      // Total value calculation
      if (bottle.price) {
        const currency = bottle.currency || 'USD';
        stats.totalValue += bottle.price;
        priceSum += bottle.price;
        priceCount++;

        // Currency-converted total: bottles already in the target currency are
        // used as-is; others are converted using the historical rate from the
        // day the price was entered, falling back to today's rates.
        if (targetCurrency) {
          if (currency === targetCurrency) {
            convertedSum += bottle.price;
            convertedCount++;
          } else {
            const dateKey = bottle.priceSetAt
              ? bottle.priceSetAt.toISOString().slice(0, 10)
              : null;
            const rates = (dateKey && snapshotMap.get(dateKey))
              || (todaySnapshot ? todaySnapshot.rates : null);
            const converted = convertCurrency(bottle.price, currency, targetCurrency, rates);
            if (converted !== null) {
              convertedSum += converted;
              convertedCount++;
            }
          }
        }
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

      // By rating — normalize to 0-100 and bucket into 5 bands
      if (bottle.rating) {
        const norm = toNormalized(bottle.rating, bottle.ratingScale || '5');
        const band = norm <= 20 ? '0-20' : norm <= 40 ? '21-40' : norm <= 60 ? '41-60' : norm <= 80 ? '61-80' : '81-100';
        stats.byRating[band] = (stats.byRating[band] || 0) + 1;
      }
    });

    stats.averagePrice = priceCount > 0 ? priceSum / priceCount : 0;
    stats.convertedTotal = convertedSum;
    stats.convertedAverage = convertedCount > 0 ? convertedSum / convertedCount : 0;
    stats.oldestVintage = oldestYear !== Infinity ? oldestYear : null;
    stats.newestVintage = newestYear !== -Infinity ? newestYear : null;

    // Drink window summary counts
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    let drinkOverdue = 0, drinkSoon = 0;
    bottles.forEach(bottle => {
      if (!bottle.drinkBefore) return;
      const daysLeft = Math.round((new Date(bottle.drinkBefore) - now) / MS_PER_DAY);
      if (daysLeft < 0) drinkOverdue++;
      else if (daysLeft <= 90) drinkSoon++;
    });
    stats.drinkOverdue = drinkOverdue;
    stats.drinkSoon = drinkSoon;

    // Round values
    stats.totalValue = Math.round(stats.totalValue * 100) / 100;
    stats.averagePrice = Math.round(stats.averagePrice * 100) / 100;
    stats.convertedTotal = Math.round(stats.convertedTotal * 100) / 100;
    stats.convertedAverage = Math.round(stats.convertedAverage * 100) / 100;

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

    // Base MongoDB filter for Bottle (direct fields only)
    const filter = {
      cellar: req.params.id,
      status: { $nin: CONSUMED_STATUSES }
    };

    // Push vintage directly into the DB query — it's a scalar field on Bottle
    if (vintage) filter.vintage = vintage;

    // Push taxonomy filters (country, region, grapes) down via a WineDefinition pre-query.
    // This avoids loading every bottle in the cellar just to discard most of them.
    const wdFilter = {};
    if (country) wdFilter.country = country;
    if (region)  wdFilter.region  = region;
    if (grapes) {
      // $all ensures every requested grape is present in the wine's grapes array
      wdFilter.grapes = { $all: grapes.split(',') };
    }

    if (Object.keys(wdFilter).length > 0) {
      const matchingWdIds = await WineDefinition.find(wdFilter).distinct('_id');
      if (matchingWdIds.length === 0) {
        // No wines match the taxonomy filter — short-circuit with empty result
        const cellarObj = cellar.toObject();
        cellarObj.userRole = role;
        cellarObj.userColor = getUserColor(cellar, req.user.id);
        return res.json({ cellar: cellarObj, bottles: { count: 0, items: [] } });
      }
      filter.wineDefinition = { $in: matchingWdIds };
    }

    // Fetch the filtered set from DB (much smaller than fetching everything first)
    let bottles = await Bottle.find(filter).populate({
      path: 'wineDefinition',
      populate: ['country', 'region', 'grapes']
    });

    // ── In-memory filters for cases that can't be expressed cleanly in Mongo ──

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

    if (minRating) {
      const min = parseFloat(minRating);
      // minRating is sent as a normalized 0-100 value; compare against normalized bottle rating
      bottles = bottles.filter(b => {
        if (!b.rating) return false;
        return toNormalized(b.rating, b.ratingScale || '5') >= min;
      });
    }

    if (maxRating) {
      const max = parseFloat(maxRating);
      bottles = bottles.filter(b => {
        if (!b.rating) return false;
        return toNormalized(b.rating, b.ratingScale || '5') <= max;
      });
    }

    // Filter by drink window status
    if (drinkStatus) {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      bottles = bottles.filter(b => {
        const before = b.drinkBefore ? new Date(b.drinkBefore) : null;
        const from = b.drinkFrom ? new Date(b.drinkFrom) : null;
        if (!before && !from) return false; // no dates set — excluded from all named statuses
        if (before) {
          const daysLeft = Math.round((before - now) / MS_PER_DAY);
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

    // Attach the uploader's own pending image to each bottle (visible before admin approval)
    const bottleIds = bottles.map(b => b._id);
    const pendingImages = await BottleImage.find({
      bottle: { $in: bottleIds },
      uploadedBy: req.user.id,
      status: { $in: ['uploaded', 'processing', 'processed'] }
    }).sort({ createdAt: -1 }).lean();

    // Keep only the most recent pending image per bottle
    const pendingByBottle = {};
    for (const img of pendingImages) {
      const key = img.bottle.toString();
      if (!pendingByBottle[key]) {
        pendingByBottle[key] = img.processedUrl || img.originalUrl;
      }
    }

    const bottleItems = bottles.map(b => {
      const obj = b.toObject();
      obj.pendingImageUrl = pendingByBottle[b._id.toString()] || null;
      return obj;
    });

    const cellarObj = cellar.toObject();
    cellarObj.userRole = role;
    cellarObj.userColor = getUserColor(cellar, req.user.id);

    res.json({
      cellar: cellarObj,
      bottles: {
        count: bottleItems.length,
        items: bottleItems
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
