// The price-tracking opt-in of a bottle: a member asks the sommeliers to follow
// the market price of this wine and vintage, withdraws that, or reads whether it
// is asked for. One request document per wine and vintage lists everyone who
// asked (models/PriceTrackingRequest); the sommeliers work the queue through
// services/priceOps.js. Mounted by routes/bottles.js, behind its auth and
// idempotency.

const express = require('express');
const { requireBottleAccess } = require('../middleware/bottleAccess');
const WineDefinition = require('../models/WineDefinition');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const { logAudit } = require('../services/audit');

const router = express.Router();

// POST /api/bottles/:id/request-price-tracking
// Opt this wine+vintage in to sommelier price tracking. Idempotent — re-posting
// from the same user updates their note + lastRequestedAt; the document is a
// singleton per (wineDefinition, vintage) so multiple requesters share it.
router.post('/:id/request-price-tracking', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle } = req;
    const userId = req.user.id;

    if (!bottle.wineDefinition || !bottle.vintage || bottle.vintage === 'NV' || bottle.vintage === 'Unknown') {
      return res.status(400).json({ error: 'This wine cannot be price-tracked (missing wine definition or vintage).' });
    }
    // A private draft is not in the shared registry yet: a tracking request
    // would put its name in front of the sommeliers who must not see it, and
    // dangle if the draft is later attached elsewhere.
    const wdId = bottle.wineDefinition?._id || bottle.wineDefinition;
    if (await WineDefinition.exists({ _id: wdId, draft: true })) {
      return res.status(400).json({ error: 'This wine is still a private draft — publish it first, then request price tracking.' });
    }

    // A sommelier-declined pair stays declined: the decline flow (somm prices)
    // records a PriceTrackingSkip, and this check is what keeps the pair from
    // being re-queued. The decline reason is surfaced so the user learns WHY
    // instead of silently re-requesting into a void.
    const skip = await PriceTrackingSkip.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    }).lean();
    if (skip) {
      return res.status(409).json({
        error: skip.reason
          ? `A sommelier reviewed this wine and declined price tracking: ${skip.reason}`
          : 'A sommelier reviewed this wine and declined price tracking.'
      });
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : undefined;
    const now = new Date();

    // Find-or-create the singleton, then add/update this user in requesters.
    let request = await PriceTrackingRequest.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    });

    if (!request) {
      request = new PriceTrackingRequest({
        wineDefinition: bottle.wineDefinition,
        vintage: bottle.vintage,
        requesters: [{ user: userId, requestedAt: now, note }],
        firstRequestedAt: now,
        lastRequestedAt: now
      });
    } else {
      const existing = request.requesters.find(r => r.user.toString() === userId);
      if (existing) {
        existing.requestedAt = now;
        if (note !== undefined) existing.note = note;
      } else {
        request.requesters.push({ user: userId, requestedAt: now, note });
      }
      request.lastRequestedAt = now;
    }

    await request.save();

    logAudit(req, 'price.track_requested',
      { type: 'wineDefinition', id: bottle.wineDefinition },
      { vintage: bottle.vintage, bottleId: bottle._id }
    );

    res.json({
      requested: true,
      requesterCount: request.requesters.length,
      firstRequestedAt: request.firstRequestedAt
    });
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key — concurrent create raced. Retry once.
      return res.status(409).json({ error: 'Tracking request already exists — please retry.' });
    }
    console.error('Request price tracking error:', error);
    res.status(500).json({ error: 'Failed to request price tracking' });
  }
});

// DELETE /api/bottles/:id/request-price-tracking
// Cancel this user's request. If they were the only requester, the singleton
// is deleted entirely so the pair drops out of the somm queue.
router.delete('/:id/request-price-tracking', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle } = req;
    const userId = req.user.id;

    const request = await PriceTrackingRequest.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    });

    if (!request) {
      return res.json({ requested: false, requesterCount: 0 });
    }

    const before = request.requesters.length;
    request.requesters = request.requesters.filter(r => r.user.toString() !== userId);

    if (request.requesters.length === 0) {
      await request.deleteOne();
    } else if (request.requesters.length !== before) {
      await request.save();
    }

    logAudit(req, 'price.track_cancelled',
      { type: 'wineDefinition', id: bottle.wineDefinition },
      { vintage: bottle.vintage, bottleId: bottle._id }
    );

    res.json({ requested: false, requesterCount: request.requesters.length });
  } catch (error) {
    console.error('Cancel price tracking error:', error);
    res.status(500).json({ error: 'Failed to cancel price tracking' });
  }
});

// GET /api/bottles/:id/request-price-tracking
// Returns whether this user has an active request for this bottle's pair.
router.get('/:id/request-price-tracking', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle } = req;
    const userId = req.user.id;

    if (!bottle.wineDefinition || !bottle.vintage) {
      return res.json({ requested: false, requesterCount: 0, eligible: false });
    }
    const eligible = bottle.vintage !== 'NV' && bottle.vintage !== 'Unknown';
    if (!eligible) {
      return res.json({ requested: false, requesterCount: 0, eligible: false });
    }

    // Declined by a curator → reported as ineligible so the request toggle
    // disappears (POST would 409 anyway; don't invite a dead-end click).
    const skip = await PriceTrackingSkip.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    }).select('_id').lean();
    if (skip) {
      return res.json({ requested: false, requesterCount: 0, eligible: false, declined: true });
    }

    const request = await PriceTrackingRequest.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    }).lean();

    if (!request) {
      return res.json({ requested: false, requesterCount: 0, eligible: true });
    }

    const mine = request.requesters.find(r => r.user.toString() === userId);
    res.json({
      requested: !!mine,
      requesterCount: request.requesters.length,
      firstRequestedAt: request.firstRequestedAt,
      eligible: true
    });
  } catch (error) {
    console.error('Get price tracking status error:', error);
    res.status(500).json({ error: 'Failed to get tracking status' });
  }
});

module.exports = router;
