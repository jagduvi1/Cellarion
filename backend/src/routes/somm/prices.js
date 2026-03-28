const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineVintagePrice = require('../../models/WineVintagePrice');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const { getOrCreateDailySnapshot, getSnapshotsForDates } = require('../../utils/exchangeRates');

const { suggestPrice } = require('../../services/labelScan');

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
      { $match: { status: 'active', wineDefinition: { $ne: null }, vintage: { $nin: ['NV', '', null] } } },
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
          latestSetAt:    { $last: '$setAt' },
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

    // Step 5: batch-fetch rate snapshots for all latestPrice dates and attach them.
    // This keeps conversion time-anchored without storing rates on every price document.
    const queueDates = [...new Set(
      queue
        .filter(item => item.latestPrice?.setAt)
        .map(item => new Date(item.latestPrice.setAt).toISOString().slice(0, 10))
    )];
    const snapshotMap = await getSnapshotsForDates(queueDates);

    const enrichedQueue = queue.map(item => {
      if (!item.latestPrice?.setAt) return item;
      const date = new Date(item.latestPrice.setAt).toISOString().slice(0, 10);
      return {
        ...item,
        latestPrice: { ...item.latestPrice, exchangeRates: snapshotMap.get(date) || null }
      };
    });

    res.json({ queue: enrichedQueue });
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
    if (!mongoose.isValidObjectId(String(wine))) {
      return res.status(400).json({ error: 'Invalid wine ID' });
    }

    const history = await WineVintagePrice.find({ wineDefinition: String(wine), vintage: String(vintage) })
      .populate('setBy', 'username')
      .sort({ setAt: -1 })
      .lean();

    // Batch-fetch rate snapshots for all entry dates and attach as exchangeRates.
    const dates = [...new Set(history.map(e => e.setAt.toISOString().slice(0, 10)))];
    const snapshotMap = await getSnapshotsForDates(dates);

    const enriched = history.map(e => ({
      ...e,
      exchangeRates: snapshotMap.get(e.setAt.toISOString().slice(0, 10)) || null
    }));

    res.json({ history: enriched });
  } catch (error) {
    console.error('Price lookup error:', error);
    res.status(500).json({ error: 'Failed to load price history' });
  }
});

/**
 * POST /api/somm/prices/ai-suggest
 * Ask AI to suggest a market price for a wine+vintage. Somm/admin only.
 * Body: { wineDefinition, vintage }
 * Returns suggested values for the form (not saved until the user confirms).
 */
router.post('/ai-suggest', requireSommOrAdmin, async (req, res) => {
  try {
    const { wineDefinition: wineId, vintage } = req.body;
    if (!wineId || !vintage) {
      return res.status(400).json({ error: 'wineDefinition and vintage are required' });
    }

    const wine = await WineDefinition.findById(wineId)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name');

    if (!wine) {
      return res.status(404).json({ error: 'Wine definition not found' });
    }

    const result = await suggestPrice({
      name: wine.name,
      producer: wine.producer,
      vintage,
      country: wine.country?.name,
      region: wine.region?.name,
      appellation: wine.appellation,
      type: wine.type,
      grapes: wine.grapes?.map(g => g.name)
    });

    if (!result.data) {
      return res.status(422).json({
        error: 'AI could not suggest a price for this wine',
        reason: result.debugReason
      });
    }

    res.json({ suggestion: result.data });
  } catch (error) {
    console.error('AI price suggest error:', error);
    res.status(500).json({ error: 'Failed to get AI suggestion' });
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

    // Ensure today's rate snapshot exists so the setAt date can be used for
    // time-anchored conversions later. Non-fatal if the API call fails.
    await getOrCreateDailySnapshot();

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
