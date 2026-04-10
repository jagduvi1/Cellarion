const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const WineList = require('../models/WineList');
const PendingShare = require('../models/PendingShare');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getSnapshotsForDates, getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
const { createNotification } = require('../services/notifications');
const { sendCellarInviteEmail, EMAIL_VERIFICATION_ENABLED } = require('../services/mailgun');
const { toNormalized } = require('../utils/ratingUtils');
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
const { CONSUMED_STATUSES, MS_PER_DAY, WINE_POPULATE } = require('../config/constants');
const mongoose = require('mongoose');
const { parsePagination } = require('../utils/pagination');
const searchService = require('../services/search');

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
      .populate(WINE_POPULATE)
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
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username').lean();
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    const {
      country,
      region,
      grapes,
      type,
      vintage,
      minRating,
      maxRating,
      search,
      maturity: maturityFilter,
      sort = '-createdAt',
      exclude
    } = req.query;

    // Pagination — default 30, max 200; skip defaults to 0
    const { limit, offset: skip } = parsePagination(req.query, { limit: 30, maxLimit: 200 });

    const { isValidObjectId } = mongoose;
    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    const sortDir = sort.startsWith('-') ? -1 : 1;

    // Parse grape IDs once (used by both paths)
    const grapeIds = grapes
      ? String(grapes).split(',').map(g => g.trim()).filter(isValidObjectId)
      : [];

    // Whether we need in-memory post-processing that neither Meilisearch nor MongoDB can do
    const needsMaturity = !!(maturityFilter || sortField === 'maturity');
    const MATURITY_RANK = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };

    // ── Determine if we can use Meilisearch as the primary search engine ──
    const hasMeiliFilters = !!(search || type || country || region || grapes || vintage);
    let usedMeili = false;
    let bottles;
    let totalCount;
    let canPaginateInDb;

    if (searchService.getIsAvailable() && hasMeiliFilters) {
      // ── PRIMARY PATH: Meilisearch handles search + filters ──
      try {
        const meiliResult = await searchService.searchBottles(search || '', {
          cellarId: req.params.id,
          type: type || undefined,
          countryId: country || undefined,
          regionId: region || undefined,
          grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
          vintage: vintage || undefined,
          sort,
          limit: 10000,  // Get all matching IDs — we paginate after in-memory filters
          offset: 0
        });

        const matchingIds = meiliResult.ids;

        if (matchingIds.length === 0) {
          // Meilisearch found nothing — short-circuit
          return res.json({
            cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
            bottles: { count: 0, total: 0, limit, skip, items: [] },
            facets: meiliResult.facetDistribution || null,
            facetMeta: null
          });
        }

        // Exclude specific bottle IDs if requested
        let idsToFetch = matchingIds;
        if (exclude) {
          const excludeSet = new Set(String(exclude).split(',').filter(isValidObjectId));
          idsToFetch = matchingIds.filter(id => !excludeSet.has(id));
        }

        // Fetch just the matching bottles from MongoDB (by ID) — much smaller query
        bottles = await Bottle.find({ _id: { $in: idsToFetch } })
          .populate(WINE_POPULATE)
          .lean();

        // Preserve Meilisearch's sort order
        const idOrder = new Map(idsToFetch.map((id, i) => [id, i]));
        bottles.sort((a, b) => (idOrder.get(a._id.toString()) ?? 0) - (idOrder.get(b._id.toString()) ?? 0));

        usedMeili = true;
        canPaginateInDb = false; // We paginate after in-memory filters below
      } catch {
        // Meilisearch failed — fall through to MongoDB path
      }
    }

    if (!usedMeili) {
      // ── FALLBACK PATH: MongoDB + in-memory (when Meilisearch unavailable) ──
      const filter = {
        cellar: req.params.id,
        status: { $nin: CONSUMED_STATUSES }
      };

      if (exclude) {
        const excludeIds = String(exclude).split(',').filter(isValidObjectId);
        if (excludeIds.length > 0) filter._id = { $nin: excludeIds };
      }
      // Vintage: single or comma-separated
      if (vintage) {
        const vintages = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
        filter.vintage = vintages.length === 1 ? vintages[0] : { $in: vintages };
      }

      // Taxonomy pre-query
      const wdFilter = {};
      if (country) {
        const countryIds = String(country).split(',').map(c => c.trim()).filter(isValidObjectId);
        if (countryIds.length === 1) wdFilter.country = countryIds[0];
        else if (countryIds.length > 1) wdFilter.country = { $in: countryIds };
      }
      if (region) {
        const regionIds = String(region).split(',').map(r => r.trim()).filter(isValidObjectId);
        if (regionIds.length === 1) wdFilter.region = regionIds[0];
        else if (regionIds.length > 1) wdFilter.region = { $in: regionIds };
      }
      if (type) {
        const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
        wdFilter.type = types.length === 1 ? types[0] : { $in: types };
      }
      if (grapeIds.length > 0) wdFilter.grapes = { $in: grapeIds };

      if (Object.keys(wdFilter).length > 0) {
        const matchingWdIds = await WineDefinition.find(wdFilter).distinct('_id');
        if (matchingWdIds.length === 0) {
          return res.json({
            cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
            bottles: { count: 0, items: [] }
          });
        }
        filter.wineDefinition = { $in: matchingWdIds };
      }

      const directSortFields = ['createdAt', 'vintage', 'price', 'rating'];
      const canSortInDb_ = directSortFields.includes(sortField);
      const needsInMemoryFilter = !!(search || minRating || maxRating || maturityFilter);
      const needsInMemorySort = !canSortInDb_;
      canPaginateInDb = !needsInMemoryFilter && !needsInMemorySort;

      let query = Bottle.find(filter).populate(WINE_POPULATE);
      if (canSortInDb_) query = query.sort({ [sortField]: sortDir });
      if (canPaginateInDb) query = query.skip(skip).limit(limit);
      bottles = await query.lean();

      if (canPaginateInDb) {
        totalCount = await Bottle.countDocuments(filter);
      }

      // In-memory text search (fallback — no typo tolerance but multi-word AND works)
      if (search) {
        const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const words = stripAccents(search.toLowerCase()).split(/\s+/).filter(Boolean);
        bottles = bottles.filter(b => {
          const allText = [
            b.wineDefinition?.name,
            b.wineDefinition?.producer,
            b.notes,
            b.location,
            b.wineDefinition?.country?.name,
            b.wineDefinition?.region?.name,
            b.wineDefinition?.appellation,
            b.wineDefinition?.type,
            ...(b.wineDefinition?.grapes || []).map(g => g.name)
          ].filter(Boolean).map(s => stripAccents(s.toLowerCase())).join(' ');
          return words.every(word => allText.includes(word));
        });
      }

      // In-memory sort for fields that require populated data
      if (needsInMemorySort) {
        let maturityStatusMap_;
        if (sortField === 'maturity') {
          const profileMap = await buildProfileMap(bottles);
          maturityStatusMap_ = new Map();
          for (const b of bottles) {
            maturityStatusMap_.set(b._id.toString(), classifyMaturity(b, profileMap));
          }
        }
        bottles.sort((a, b) => {
          let aVal, bVal;
          if (sortField === 'name') {
            aVal = a.wineDefinition?.name || '';
            bVal = b.wineDefinition?.name || '';
          } else if (sortField === 'maturity' && maturityStatusMap_) {
            const aStatus = maturityStatusMap_.get(a._id.toString());
            const bStatus = maturityStatusMap_.get(b._id.toString());
            aVal = aStatus != null ? MATURITY_RANK[aStatus] : 5;
            bVal = bStatus != null ? MATURITY_RANK[bStatus] : 5;
          } else {
            aVal = a.createdAt;
            bVal = b.createdAt;
          }
          if (aVal < bVal) return -sortDir;
          if (aVal > bVal) return sortDir;
          return 0;
        });
      }
    }

    // ── Shared post-filters (applied to both Meilisearch and fallback paths) ──

    if (minRating) {
      const min = parseFloat(minRating);
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

    let maturityStatusMap;
    if (needsMaturity) {
      const profileMap = await buildProfileMap(bottles);
      maturityStatusMap = new Map();
      for (const b of bottles) {
        maturityStatusMap.set(b._id.toString(), classifyMaturity(b, profileMap));
      }
    }

    if (maturityFilter && maturityStatusMap) {
      if (maturityFilter === 'none') {
        bottles = bottles.filter(b => maturityStatusMap.get(b._id.toString()) == null);
      } else {
        bottles = bottles.filter(b => maturityStatusMap.get(b._id.toString()) === maturityFilter);
      }
    }

    // Paginate (for paths that didn't paginate in DB)
    if (!canPaginateInDb) {
      totalCount = bottles.length;
      bottles = bottles.slice(skip, skip + limit);
    }

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

    // Resolve user-chosen default images for bottles that have one set
    const defaultImageIds = bottles
      .filter(b => b.defaultImage)
      .map(b => b.defaultImage);
    const defaultImages = defaultImageIds.length > 0
      ? await BottleImage.find({ _id: { $in: defaultImageIds } }).lean()
      : [];
    const defaultImageMap = {};
    for (const img of defaultImages) {
      defaultImageMap[img._id.toString()] = img.processedUrl || img.originalUrl;
    }

    const bottleItems = bottles.map(b => ({
      ...b,
      pendingImageUrl: pendingByBottle[b._id.toString()] || null,
      defaultImageUrl: b.defaultImage ? (defaultImageMap[b.defaultImage.toString()] || null) : null,
      ...(maturityStatusMap ? { maturityStatus: maturityStatusMap.get(b._id.toString()) || null } : {})
    }));

    // ── Facets: two queries for smart cascading ──
    // 1. baseFacets: unfiltered — shows ALL options so users can always add more selections
    // 2. facets: filtered — reflects what's available given current filters (for counts + cascading)
    let facets = null;
    let baseFacets = null;
    let facetMeta = null;
    const hasAnyFilter = !!(type || country || region || grapes || vintage || search);
    if (searchService.getIsAvailable()) {
      try {
        // Always fetch unfiltered facets for showing all available options
        const baseResult = await searchService.searchBottles('', {
          cellarId: req.params.id,
          limit: 0, offset: 0
        });
        baseFacets = baseResult.facetDistribution || null;

        // If filters are active, also fetch filtered facets for cascading counts
        if (hasAnyFilter) {
          const filteredResult = await searchService.searchBottles(search || '', {
            cellarId: req.params.id,
            type: type || undefined,
            countryId: country || undefined,
            regionId: region || undefined,
            grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
            vintage: vintage || undefined,
            limit: 0, offset: 0
          });
          facets = filteredResult.facetDistribution || null;
        } else {
          facets = baseFacets;
        }
      } catch {
        // Meilisearch unavailable — skip facets
      }
    }

    // Build name→ID mappings so the frontend can show names but filter by ID.
    // Query the distinct WineDefinitions for this cellar (fast: typically <200 unique wines).
    if (baseFacets || facets) {
      const wdIds = await Bottle.find({
        cellar: req.params.id,
        status: { $nin: CONSUMED_STATUSES }
      }).distinct('wineDefinition');

      const wds = await WineDefinition.find({ _id: { $in: wdIds } })
        .populate('country', 'name')
        .populate('region', 'name')
        .populate('grapes', 'name')
        .lean();

      const countries = {};
      const regions = {};
      const grapesMap = {};
      for (const wd of wds) {
        if (wd.country?.name && wd.country._id) {
          countries[wd.country.name] = wd.country._id.toString();
        }
        if (wd.region?.name && wd.region._id) {
          regions[wd.region.name] = wd.region._id.toString();
        }
        for (const g of (wd.grapes || [])) {
          if (g.name && g._id) grapesMap[g.name] = g._id.toString();
        }
      }
      facetMeta = { countries, regions, grapes: grapesMap };
    }

    res.json({
      cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
      bottles: {
        total: totalCount,
        count: bottleItems.length,
        limit,
        skip,
        items: bottleItems
      },
      ...(facets ? { facets, baseFacets, facetMeta } : {})
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

    // Delete wine lists for this cellar (hard delete — no soft-delete for wine lists)
    await WineList.deleteMany({ cellar: cellar._id });

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

    const normalizedEmail = email.toLowerCase().trim();

    // Look up user by email
    const userToAdd = await User.findOne({ email: normalizedEmail });

    // Can't share with yourself
    if (userToAdd && userToAdd._id.toString() === req.user.id.toString()) {
      return res.status(400).json({ error: 'Cannot share a cellar with yourself' });
    }

    if (!userToAdd) {
      // User doesn't exist — create a pending invite and send an email
      const existingPending = await PendingShare.findOne({ email: normalizedEmail, cellar: cellar._id });
      if (existingPending) {
        return res.status(400).json({ error: 'An invitation has already been sent to this email' });
      }

      const sharingUser = await User.findById(req.user.id).select('username email').lean();

      await PendingShare.create({
        email: normalizedEmail,
        cellar: cellar._id,
        role,
        invitedBy: req.user.id
      });

      sendCellarInviteEmail(
        normalizedEmail,
        sharingUser?.username ?? 'A Cellarion user',
        sharingUser?.email ?? '',
        cellar.name,
        role
      ).catch(err => {
        console.error('Failed to send cellar invite email:', err.message);
      });

      logAudit(req, 'cellar.share.invite',
        { type: 'cellar', id: cellar._id, cellarId: cellar._id },
        { invitedEmail: normalizedEmail, role }
      );

      return res.status(202).json({
        invited: true,
        message: `Invitation sent to ${normalizedEmail}. The cellar will be shared when they join Cellarion.`
      });
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

    // Re-check member count after save to catch race conditions
    if (planConfig.maxSharesPerCellar !== -1) {
      const freshCellar = await Cellar.findById(cellar._id).select('members').lean();
      if (freshCellar.members.length > planConfig.maxSharesPerCellar) {
        await Cellar.updateOne({ _id: cellar._id }, { $pull: { members: { user: userToAdd._id } } });
        return res.status(403).json({
          error: `Your ${req.user.plan} plan allows a maximum of ${planConfig.maxSharesPerCellar} shared member${planConfig.maxSharesPerCellar === 1 ? '' : 's'} per cellar.`,
          limitReached: 'shares',
          limit: planConfig.maxSharesPerCellar,
          currentPlan: req.user.plan,
        });
      }
    }

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
// GET /api/cellars/:id/export — owner only, no images, no staff-curated data
router.get('/:id/export', async (req, res) => {
  try {
    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null });
    if (!cellar) return res.status(403).json({ error: 'Not authorized — only the cellar owner can export' });

    const [bottles, racks] = await Promise.all([
      Bottle.find({ cellar: req.params.id })
        .populate({
          path: 'wineDefinition',
          populate: [
            { path: 'country', select: 'name' },
            { path: 'region', select: 'name' }
          ],
          select: 'name producer type appellation country region'
        })
        .lean(),
      Rack.find({ cellar: req.params.id, deletedAt: null }).lean()
    ]);

    // Build map: bottleId → { rackName, rackPosition, rackRow, rackCol }
    const bottleRackMap = new Map();
    for (const rack of racks) {
      for (const slot of rack.slots || []) {
        const row = Math.ceil(slot.position / rack.cols);
        const col = ((slot.position - 1) % rack.cols) + 1;
        bottleRackMap.set(slot.bottle.toString(), {
          rackName: rack.name,
          rackPosition: slot.position,
          rackRow: row,
          rackCol: col
        });
      }
    }

    const items = bottles.map(b => {
      const wine = b.wineDefinition || {};
      const item = {
        wineName: wine.name || '',
        producer: wine.producer || '',
        vintage: b.vintage || 'NV',
        country: wine.country?.name || '',
        region: wine.region?.name || '',
        appellation: wine.appellation || '',
        type: wine.type || '',
        bottleSize: b.bottleSize || '750ml',
        dateAdded: b.createdAt ? b.createdAt.toISOString().slice(0, 10) : undefined,
      };

      // User-entered pricing
      if (b.price != null) {
        item.price = b.price;
        item.currency = b.currency || 'USD';
      }

      // User-entered purchase info
      if (b.purchaseDate) item.purchaseDate = b.purchaseDate.toISOString().slice(0, 10);
      if (b.purchaseLocation) item.purchaseLocation = b.purchaseLocation;
      if (b.purchaseUrl) item.purchaseUrl = b.purchaseUrl;
      if (b.location) item.location = b.location;
      if (b.notes) item.notes = b.notes;

      // User-entered rating
      if (b.rating != null) {
        item.rating = b.rating;
        item.ratingScale = b.ratingScale || '5';
      }

      // Rack placement
      const rackInfo = bottleRackMap.get(b._id.toString());
      if (rackInfo) {
        item.rackName = rackInfo.rackName;
        item.rackPosition = rackInfo.rackPosition;
        item.rackRow = rackInfo.rackRow;
        item.rackCol = rackInfo.rackCol;
      }

      // Consumed / history bottles
      if (b.status && b.status !== 'active') {
        item.addToHistory = true;
        item.consumedReason = b.consumedReason || b.status;
        if (b.consumedAt) item.consumedAt = b.consumedAt.toISOString().slice(0, 10);
        if (b.consumedNote) item.consumedNote = b.consumedNote;
        if (b.consumedRating != null) {
          item.consumedRating = b.consumedRating;
          item.consumedRatingScale = b.consumedRatingScale || '5';
        }
      }

      return item;
    });

    logAudit(req, 'cellar.export', { type: 'cellar', id: cellar._id }, { bottleCount: items.length });

    res.json({ cellarName: cellar.name, exportedAt: new Date().toISOString(), bottles: items });
  } catch (error) {
    console.error('Export cellar error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

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
