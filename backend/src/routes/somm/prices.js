const express = require('express');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineVintagePrice = require('../../models/WineVintagePrice');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');

const router = express.Router();

router.use(requireAuth);

const STALE_MS = 90 * 24 * 60 * 60 * 1000; // 3 months in milliseconds

/**
 * GET /api/somm/prices/queue
 * Returns wine+vintage pairs that have no price history, or whose most recent
 * price snapshot is older than 3 months. Somm/admin only.
 */
router.get('/queue', requireSommOrAdmin, async (req, res) => {
  try {
    const staleThreshold = new Date(Date.now() - STALE_MS);

    // Step 1: unique (wineDefinition, vintage) pairs with at least one active bottle
    const rawPairs = await Bottle.aggregate([
      { $match: { status: 'active', vintage: { $nin: ['NV', '', null] } } },
      {
        $group: {
          _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' },
          bottleCount: { $sum: 1 }
        }
      }
    ]);

    if (rawPairs.length === 0) return res.json({ queue: [] });

    // Step 2: find the latest price snapshot for each pair in one aggregation
    const latestPrices = await WineVintagePrice.aggregate([
      {
        $group: {
          _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' },
          latestSetAt: { $max: '$setAt' },
          latestPrice:    { $last: '$price' },
          latestCurrency: { $last: '$currency' },
          latestSource:   { $last: '$source' }
        }
      }
    ]);

    // Build lookup map
    const priceMap = new Map();
    for (const lp of latestPrices) {
      const key = `${lp._id.wineDefinition}:${lp._id.vintage}`;
      priceMap.set(key, lp);
    }

    // Step 3: filter pairs that need attention
    const needsUpdate = rawPairs.filter(p => {
      const key = `${p._id.wineDefinition}:${p._id.vintage}`;
      const latest = priceMap.get(key);
      return !latest || latest.latestSetAt < staleThreshold;
    });

    if (needsUpdate.length === 0) return res.json({ queue: [] });

    // Step 4: populate wine definitions for the filtered pairs
    const wineIds = [...new Set(needsUpdate.map(p => p._id.wineDefinition.toString()))];
    const wines = await WineDefinition.find({ _id: { $in: wineIds } })
      .populate('country', 'name')
      .populate('region', 'name')
      .lean();
    const wineMap = new Map(wines.map(w => [w._id.toString(), w]));

    const queue = needsUpdate.map(p => {
      const key = `${p._id.wineDefinition}:${p._id.vintage}`;
      const latest = priceMap.get(key);
      return {
        wineDefinition: wineMap.get(p._id.wineDefinition.toString()) || null,
        vintage:       p._id.vintage,
        bottleCount:   p.bottleCount,
        latestPrice:   latest
          ? { price: latest.latestPrice, currency: latest.latestCurrency, setAt: latest.latestSetAt, source: latest.latestSource }
          : null
      };
    });

    // Sort: no history first, then by oldest update
    queue.sort((a, b) => {
      if (!a.latestPrice && !b.latestPrice) return 0;
      if (!a.latestPrice) return -1;
      if (!b.latestPrice) return 1;
      return new Date(a.latestPrice.setAt) - new Date(b.latestPrice.setAt);
    });

    res.json({ queue });
  } catch (error) {
    console.error('Price queue error:', error);
    res.status(500).json({ error: 'Failed to load price queue' });
  }
});

/**
 * GET /api/somm/prices/lookup?wine=:wineId&vintage=:vintage
 * Returns the full price history for a wine+vintage (newest first).
 * Any authenticated user — used by BottleDetail for premium users.
 */
router.get('/lookup', async (req, res) => {
  try {
    const { wine, vintage } = req.query;
    if (!wine || !vintage) {
      return res.status(400).json({ error: 'wine and vintage query params required' });
    }

    const history = await WineVintagePrice.find({ wineDefinition: wine, vintage })
      .populate('setBy', 'username')
      .sort({ setAt: -1 })
      .lean();

    res.json({ history });
  } catch (error) {
    console.error('Price lookup error:', error);
    res.status(500).json({ error: 'Failed to load price history' });
  }
});

/**
 * POST /api/somm/prices
 * Add a new price snapshot for a wine+vintage. Somm/admin only.
 * Body: { wineDefinition, vintage, price, currency, source }
 */
router.post('/', requireSommOrAdmin, async (req, res) => {
  try {
    const { wineDefinition, vintage, price, currency, source } = req.body;

    if (!wineDefinition || !vintage) {
      return res.status(400).json({ error: 'wineDefinition and vintage are required' });
    }
    if (price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'price is required' });
    }
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }

    // Verify the wine exists
    const wineExists = await WineDefinition.exists({ _id: wineDefinition });
    if (!wineExists) {
      return res.status(404).json({ error: 'Wine definition not found' });
    }

    const entry = new WineVintagePrice({
      wineDefinition,
      vintage,
      price: priceNum,
      currency: currency || 'USD',
      source: source ? source.trim() : undefined,
      setBy: req.user.id
    });

    await entry.save();
    await entry.populate('setBy', 'username');

    res.status(201).json({ entry });
  } catch (error) {
    console.error('Add price entry error:', error);
    res.status(500).json({ error: 'Failed to add price entry' });
  }
});

module.exports = router;
