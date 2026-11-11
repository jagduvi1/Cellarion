const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineVintagePrice = require('../../models/WineVintagePrice');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const { getSnapshotsForDates } = require('../../utils/exchangeRates');
const { SUPPORTED_CURRENCIES } = require('../../config/currencies');
const { isValidId } = require('../../utils/validation');
// The curation body shared with the MCP somm tools: queue rules, snapshot,
// decline and their undo. This route parses input and words the answers.
const priceOps = require('../../services/priceOps');

const aiConfig = require('../../config/aiConfig');
const { suggestPrice } = require('../../services/labelScan');

const router = express.Router();

router.use(requireAuth);

const { DECLINE_REASON_MIN, DECLINE_REASON_MAX } = priceOps;

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

    // Step 2: the actionable pairs in queue order — wine still there, not
    // declined, no price or a stale one (services/priceOps, the same rules
    // as list_price_tracking_requests).
    const actionable = await priceOps.actionablePriceRequests(requests);
    if (actionable.length === 0) return res.json({ queue: [] });

    // Step 3: bottle counts per pair (so somms see how many users are affected)
    const bottleCounts = await Bottle.aggregate([
      { $match: {
          status: 'active',
          wineDefinition: { $in: actionable.map(({ request: r }) => r.wineDefinition._id) },
          vintage: { $in: actionable.map(({ request: r }) => r.vintage) }
      }},
      { $group: {
          _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' },
          bottleCount: { $sum: 1 }
      }}
    ]);
    const bottleCountMap = new Map(bottleCounts.map(b => [
      priceOps.pairKey(b._id.wineDefinition, b._id.vintage), b.bottleCount
    ]));

    const queue = actionable.map(({ request: r, latest }) => {
      const requesters = r.requesters || [];
      const firstReq = requesters[0];
      return {
        requestId:      r._id,
        wineDefinition: r.wineDefinition,
        vintage:        r.vintage,
        bottleCount:    bottleCountMap.get(priceOps.pairKey(r.wineDefinition._id, r.vintage)) || 0,
        requesterCount: requesters.length,
        firstRequestedAt: r.firstRequestedAt,
        firstRequester:  firstReq ? { username: firstReq.user?.username, note: firstReq.note } : null,
        latestPrice: latest
          ? { price: latest.price, currency: latest.currency, setAt: latest.setAt, source: latest.source }
          : null
      };
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
    if (!isValidId(wineId)) {
      return res.status(400).json({ error: 'Invalid wineDefinition ID' });
    }

    const wine = await WineDefinition.findById(wineId)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name');

    // A user's private draft is nobody's curation work (draft design 2026-09-12).
    if (!wine || wine.draft === true) {
      return res.status(404).json({ error: 'Wine definition not found' });
    }

    // Cost control — see the same gate on the maturity
    // suggestion. The curator researches market prices anyway.
    if (!aiConfig.get().sommPriceSuggestEnabled) {
      return res.status(503).json({
        error: 'AI price suggestions are turned off — set the price from your own research.',
        code: 'suggestion_disabled',
      });
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
    if (!isValidId(wineDefinition)) {
      return res.status(400).json({ error: 'Invalid wineDefinition ID' });
    }
    if (typeof vintage !== 'string') {
      return res.status(400).json({ error: 'vintage must be a string' });
    }
    const wineDefId = String(wineDefinition);
    // The bottles' canonical vintage, shared with the MCP tool; the wording is this route's.
    const parsedVintage = priceOps.parsePriceVintage(vintage);
    if (!parsedVintage.ok) {
      if (parsedVintage.code === 'required') return res.status(400).json({ error: 'wineDefinition and vintage are required' });
      if (parsedVintage.code === 'unknown') return res.status(400).json({ error: 'A price needs a vintage year or NV' });
      return res.status(400).json({ error: parsedVintage.error });
    }
    // The whole value must be a number: a figure with a decimal comma or a
    // trailing unit is refused, not cut off at the first stray character, and
    // an infinite one never reaches the shared price history.
    const priceNum = typeof price === 'number' ? price
      : typeof price === 'string' ? Number(price.trim())
        : NaN;
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }

    // Verify the wine exists (a private draft is not registry content — same 404)
    const wineExists = await WineDefinition.exists({ _id: wineDefId, draft: { $ne: true } });
    if (!wineExists) {
      return res.status(404).json({ error: 'Wine definition not found' });
    }

    const safeCurrency = priceOps.normalizeCurrency(currency);
    if (!safeCurrency.ok) {
      return res.status(400).json({ error: `Unsupported currency (use one of: ${SUPPORTED_CURRENCIES.join(', ')})` });
    }

    // Rate snapshot, save, audit and the requesters' notification: the same
    // body as the MCP set_vintage_price (services/priceOps).
    const entry = await priceOps.addPriceSnapshot({
      wineId: wineDefId,
      vintage: parsedVintage.value,
      price: priceNum,
      currency: safeCurrency.value,
      source,
      sommNotes,
      actorId: req.user.id,
      req,
    });
    await entry.populate('setBy', 'username');

    res.status(201).json({ entry });
  } catch (error) {
    console.error('Add price entry error:', error);
    res.status(500).json({ error: 'Failed to add price entry' });
  }
});

/**
 * POST /api/somm/prices/requests/:requestId/decline
 * Decline a price tracking request WITH a required reason. Somm/admin only.
 * Body: { reason } — 5–500 chars, HTML-stripped; sent verbatim to every
 * requester's notification.
 *
 * Removes the request and records a PriceTrackingSkip for the pair, which
 * (a) keeps the pair out of the queue and (b) makes routes/bottlePriceTracking.js refuse
 * future tracking requests for the same wine+vintage while the skip stands.
 * (There is no reason-less delete: junk requests need a decline path the
 * requester learns from.)
 */
router.post('/requests/:requestId/decline', requireSommOrAdmin, async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.isValidObjectId(requestId)) {
      return res.status(400).json({ error: 'Invalid request ID' });
    }

    // Required, human-written reason — HTML-stripped and length-bounded before
    // it reaches the skip document and the requester notifications.
    const checked = priceOps.validateDeclineReason(req.body?.reason);
    if (!checked.ok) {
      return res.status(400).json({ error: checked.code === 'long'
        ? `Reason too long (max ${DECLINE_REASON_MAX} characters)`
        : `A decline reason of at least ${DECLINE_REASON_MIN} characters is required — the requester(s) will see it` });
    }

    const request = await PriceTrackingRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Tracking request not found — it may already be fulfilled or declined' });
    }

    // Skip upserted, request deleted, requesters told verbatim, audited: the
    // same body as the MCP reject_price_request (services/priceOps).
    const declined = await priceOps.declinePriceRequest({ request, reason: checked.reason, actorId: req.user.id, req });
    // Another curator declined it between the load above and the delete.
    if (declined.gone) {
      return res.status(404).json({ error: 'Tracking request not found — it may already be fulfilled or declined' });
    }

    res.json({ message: 'Tracking request declined', requestersNotified: declined.requestersNotified });
  } catch (error) {
    console.error('Decline tracking request error:', error);
    res.status(500).json({ error: 'Failed to decline tracking request' });
  }
});

module.exports = router;
