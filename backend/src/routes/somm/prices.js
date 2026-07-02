const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineVintagePrice = require('../../models/WineVintagePrice');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const { getOrCreateDailySnapshot, getSnapshotsForDates } = require('../../utils/exchangeRates');
const { createNotification } = require('../../services/notifications');

const { suggestPrice } = require('../../services/labelScan');

const router = express.Router();

router.use(requireAuth);

const STALE_MS = 90 * 24 * 60 * 60 * 1000; // 3 months

/**
 * GET /api/somm/prices/queue
 * Returns user-requested wine+vintage pairs awaiting sommelier curation.
 * Sorted by most-requested first, then oldest request. Somm/admin only.
 *
 * Each item carries: the wine, requester count, first requester username/note,
 * latest price snapshot (if any, for staleness UI), and active-bottle count.
 */
router.get('/queue', requireSommOrAdmin, async (req, res) => {
  try {
    // Step 1: load every active tracking request, newest-requester populated
    const requests = await PriceTrackingRequest.find({})
      .populate({ path: 'wineDefinition', populate: [
        { path: 'country', select: 'name' },
        { path: 'region',  select: 'name' }
      ]})
      .populate('requesters.user', 'username')
      .lean();

    if (requests.length === 0) return res.json({ queue: [] });

    // Drop any requests whose wine was deleted out from under them.
    const validRequests = requests.filter(r => r.wineDefinition);
    if (validRequests.length === 0) return res.json({ queue: [] });

    // Step 2: latest price snapshot per pair (for staleness display).
    // $last is only meaningful with a defined input order — sort by setAt
    // first, or "latest" is whatever natural order happens to yield.
    const latestPrices = await WineVintagePrice.aggregate([
      { $sort: { setAt: 1 } },
      { $group: {
          _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' },
          latestSetAt:    { $last: '$setAt' },
          latestPrice:    { $last: '$price' },
          latestCurrency: { $last: '$currency' },
          latestSource:   { $last: '$source' }
      }}
    ]);
    const priceMap = new Map(latestPrices.map(lp => [
      `${lp._id.wineDefinition}:${lp._id.vintage}`, lp
    ]));

    // Step 3: bottle counts per pair (so somms see how many users are affected)
    const bottleCounts = await Bottle.aggregate([
      { $match: {
          status: 'active',
          wineDefinition: { $in: validRequests.map(r => r.wineDefinition._id) },
          vintage: { $in: validRequests.map(r => r.vintage) }
      }},
      { $group: {
          _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' },
          bottleCount: { $sum: 1 }
      }}
    ]);
    const bottleCountMap = new Map(bottleCounts.map(b => [
      `${b._id.wineDefinition}:${b._id.vintage}`, b.bottleCount
    ]));

    // Filter to actionable items: no price history yet, OR latest price is stale (>3 months old).
    const staleThreshold = new Date(Date.now() - STALE_MS);
    const actionable = validRequests.filter(r => {
      const latest = priceMap.get(`${r.wineDefinition._id}:${r.vintage}`);
      return !latest || latest.latestSetAt < staleThreshold;
    });
    if (actionable.length === 0) return res.json({ queue: [] });

    const queue = actionable.map(r => {
      const key = `${r.wineDefinition._id}:${r.vintage}`;
      const latest = priceMap.get(key);
      const firstReq = r.requesters[0];
      return {
        requestId:      r._id,
        wineDefinition: r.wineDefinition,
        vintage:        r.vintage,
        bottleCount:    bottleCountMap.get(key) || 0,
        requesterCount: r.requesters.length,
        firstRequestedAt: r.firstRequestedAt,
        firstRequester:  firstReq ? { username: firstReq.user?.username, note: firstReq.note } : null,
        latestPrice: latest
          ? { price: latest.latestPrice, currency: latest.latestCurrency, setAt: latest.latestSetAt, source: latest.latestSource }
          : null
      };
    });

    // Sort: most requesters first, then oldest first-request
    queue.sort((a, b) => {
      if (b.requesterCount !== a.requesterCount) return b.requesterCount - a.requesterCount;
      return new Date(a.firstRequestedAt) - new Date(b.firstRequestedAt);
    });

    // Step 4: attach exchange-rate snapshots for time-anchored display
    const queueDates = [...new Set(
      queue.filter(item => item.latestPrice?.setAt)
           .map(item => new Date(item.latestPrice.setAt).toISOString().slice(0, 10))
    )];
    const snapshotMap = await getSnapshotsForDates(queueDates);

    const enrichedQueue = queue.map(item => {
      if (!item.latestPrice?.setAt) return item;
      const date = new Date(item.latestPrice.setAt).toISOString().slice(0, 10);
      return { ...item, latestPrice: { ...item.latestPrice, exchangeRates: snapshotMap.get(date) || null } };
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
      classification: wine.classification,
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
 * Body: { wineDefinition, vintage, price, currency, source, sommNotes }
 */
router.post('/', requireSommOrAdmin, async (req, res) => {
  try {
    const { wineDefinition, vintage, price, currency, source, sommNotes } = req.body;

    if (!wineDefinition || !vintage) {
      return res.status(400).json({ error: 'wineDefinition and vintage are required' });
    }
    if (price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'price is required' });
    }
    // Coerce + validate user-controlled values before they reach Mongo queries.
    // Without this an attacker could pass an object like { $ne: null } as the
    // vintage and turn an exact-match into a broad query.
    if (!mongoose.isValidObjectId(wineDefinition)) {
      return res.status(400).json({ error: 'Invalid wineDefinition ID' });
    }
    if (typeof vintage !== 'string') {
      return res.status(400).json({ error: 'vintage must be a string' });
    }
    const wineDefId = String(wineDefinition);
    const safeVintage = vintage.trim();
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }

    // Verify the wine exists
    const wineExists = await WineDefinition.exists({ _id: wineDefId });
    if (!wineExists) {
      return res.status(404).json({ error: 'Wine definition not found' });
    }

    // Ensure today's rate snapshot exists so the setAt date can be used for
    // time-anchored conversions later. Non-fatal if the API call fails.
    await getOrCreateDailySnapshot();

    const entry = new WineVintagePrice({
      wineDefinition: wineDefId,
      vintage: safeVintage,
      price: priceNum,
      currency: currency || 'USD',
      source: source ? source.trim() : undefined,
      sommNotes: sommNotes ? sommNotes.trim() : undefined,
      setBy: req.user.id
    });

    await entry.save();
    await entry.populate('setBy', 'username');

    // Notify everyone who requested tracking for this pair (best-effort,
    // never block the response on it).
    PriceTrackingRequest.findOne({ wineDefinition: wineDefId, vintage: safeVintage })
      .populate('wineDefinition', 'name producer')
      .then(request => {
        if (!request || !request.requesters.length) return;
        const wineLabel = request.wineDefinition
          ? [request.wineDefinition.producer, request.wineDefinition.name].filter(Boolean).join(' — ')
          : 'wine';
        const title = 'Market price updated';
        const body = `A sommelier just added a market price for ${wineLabel} ${safeVintage}: ${entry.currency} ${entry.price}.`;
        for (const r of request.requesters) {
          createNotification(r.user, 'price_tracked', title, body, '/somm/prices');
        }
      })
      .catch(err => console.error('Notify price requesters failed:', err.message));

    res.status(201).json({ entry });
  } catch (error) {
    console.error('Add price entry error:', error);
    res.status(500).json({ error: 'Failed to add price entry' });
  }
});

/**
 * DELETE /api/somm/prices/requests/:requestId
 * Decline a price tracking request. Removes the request entirely and notifies
 * all requesters that their request was declined. Somm/admin only.
 */
router.delete('/requests/:requestId', requireSommOrAdmin, async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.isValidObjectId(requestId)) {
      return res.status(400).json({ error: 'Invalid request ID' });
    }

    const request = await PriceTrackingRequest.findById(requestId)
      .populate('wineDefinition', 'name producer');
    if (!request) {
      return res.status(404).json({ error: 'Tracking request not found' });
    }

    const wineLabel = request.wineDefinition
      ? [request.wineDefinition.producer, request.wineDefinition.name].filter(Boolean).join(' — ')
      : 'this wine';
    const title = 'Price tracking request declined';
    const body = `Your request to track market price for ${wineLabel} ${request.vintage} was declined by a sommelier.`;
    for (const r of request.requesters) {
      createNotification(r.user, 'price_tracking_declined', title, body, null);
    }

    await request.deleteOne();
    res.json({ message: 'Tracking request declined' });
  } catch (error) {
    console.error('Decline tracking request error:', error);
    res.status(500).json({ error: 'Failed to decline tracking request' });
  }
});

// NOTE: the old POST/DELETE /skip endpoints (used with PriceTrackingSkip) were
// removed when the queue became opt-in. The replacement is
// DELETE /api/somm/prices/requests/:id (above). PriceTrackingSkip docs are
// no longer read by anything but the collection is left in place for audit.

module.exports = router;
