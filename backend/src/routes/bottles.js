const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireBottleAccess } = require('../middleware/bottleAccess');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const BottleImage = require('../models/BottleImage');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getOrCreateDailySnapshot, getSnapshotForDate } = require('../utils/exchangeRates');
const { resolveRating } = require('../utils/ratingUtils');
const { embedSinglePair } = require('../services/embeddingJob');
const { CONSUMED_STATUSES, WINE_POPULATE } = require('../config/constants');
const { stripHtml, isSafeUrl } = require('../utils/sanitize');

const router = express.Router();

// Remove a bottle from every rack slot that references it
async function removeFromRacks(bottleId) {
  await Rack.updateMany(
    { 'slots.bottle': bottleId },
    { $pull: { slots: { bottle: bottleId } } }
  );
}

// All routes require authentication
router.use(requireAuth);

// POST /api/bottles - Add bottle to cellar (owner or editor)
router.post('/', async (req, res) => {
  try {
    const {
      cellar,
      wineDefinition,
      vintage,
      price,
      currency,
      bottleSize,
      purchaseDate,
      purchaseLocation,
      purchaseUrl,
      location,
      notes,
      rating,
      ratingScale,
      drinkFrom,
      drinkBefore,
      // Migration helpers — let users backdate bottles or add directly to history
      dateAdded,
      addToHistory,
      consumedAt,
      consumedReason,
      consumedNote,
      consumedRating,
      consumedRatingScale
    } = req.body;

    if (!cellar || !wineDefinition) {
      return res.status(400).json({ error: 'Cellar and wine definition are required' });
    }

    if (purchaseUrl && !isSafeUrl(purchaseUrl)) {
      return res.status(400).json({ error: 'purchaseUrl must be a valid http or https URL' });
    }

    const { rating: resolvedRating, ratingScale: resolvedRatingScale, error: ratingError } = resolveRating(rating, ratingScale);
    if (ratingError) return res.status(400).json({ error: ratingError });

    // Validate add-to-history fields
    if (addToHistory) {
      if (consumedReason && !CONSUMED_STATUSES.includes(consumedReason)) {
        return res.status(400).json({ error: 'Invalid consumed reason' });
      }
    }
    const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumeRatingError } =
      addToHistory ? resolveRating(consumedRating, consumedRatingScale) : { rating: undefined, ratingScale: undefined, error: null };
    if (consumeRatingError) return res.status(400).json({ error: consumeRatingError });

    // Verify user has editor/owner access to this cellar
    const cellarDoc = await Cellar.findById(cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to add bottles to this cellar' });
    }

    // Verify wine definition exists
    const wineDoc = await WineDefinition.findById(wineDefinition);
    if (!wineDoc) {
      return res.status(404).json({ error: 'Wine definition not found' });
    }

    // Ensure today's rate snapshot exists so historical conversion works later.
    // Non-fatal: price still saves if the API call fails.
    const priceSetAt = (price !== undefined && price !== null && price !== '')
      ? new Date()
      : undefined;
    if (priceSetAt) await getOrCreateDailySnapshot();

    // Bottle always belongs to the cellar owner (clean ownership model)
    const bottle = new Bottle({
      cellar,
      user: cellarDoc.user,
      wineDefinition,
      vintage: vintage || 'NV',
      price,
      currency: currency || 'USD',
      priceSetAt,
      bottleSize: bottleSize || '750ml',
      purchaseDate,
      purchaseLocation: stripHtml(purchaseLocation),
      purchaseUrl,
      location: stripHtml(location),
      notes: stripHtml(notes),
      rating: resolvedRating,
      ratingScale: resolvedRatingScale,
      drinkFrom,
      drinkBefore
    });

    // Allow backdating the "added" date for cellar migration
    if (dateAdded) bottle.createdAt = new Date(dateAdded);

    // Allow creating bottles directly as consumed (add to history)
    if (addToHistory) {
      const reason = consumedReason || 'drank';
      bottle.status = reason;
      bottle.consumedReason = reason;
      bottle.consumedAt = consumedAt ? new Date(consumedAt) : new Date();
      if (consumedNote) bottle.consumedNote = stripHtml(consumedNote);
      if (resolvedConsumedRating !== undefined) {
        bottle.consumedRating = resolvedConsumedRating;
        bottle.consumedRatingScale = resolvedConsumedScale;
      }
    }

    await bottle.save();
    await bottle.populate(WINE_POPULATE);

    // Auto-create a pending WineVintageProfile if the vintage is a numeric year
    // and one doesn't already exist. The somm queue will pick this up.
    const vintageYear = parseInt(vintage);
    if (vintage && vintage !== 'NV' && !isNaN(vintageYear)) {
      try {
        await WineVintageProfile.findOneAndUpdate(
          { wineDefinition: wineDefinition, vintage: String(vintageYear) },
          { $setOnInsert: { wineDefinition, vintage: String(vintageYear), status: 'pending' } },
          { upsert: true, new: false }
        );
      } catch (profileErr) {
        // Non-fatal: log but don't fail the bottle creation
        console.warn('WineVintageProfile upsert warning:', profileErr.message);
      }
    }

    logAudit(req, addToHistory ? 'bottle.addToHistory' : 'bottle.add',
      { type: 'bottle', id: bottle._id, cellarId: cellarDoc._id },
      { wineName: bottle.wineDefinition?.name, vintage: bottle.vintage }
    );

    // Fire-and-forget: embed this (wine, vintage) pair for AI chat
    embedSinglePair(wineDefinition, bottle.vintage).catch(() => {});

    res.status(201).json({ bottle });
  } catch (error) {
    console.error('Create bottle error:', error);
    res.status(500).json({ error: 'Failed to create bottle' });
  }
});

// GET /api/bottles/:id - Get bottle details (owner, editor, or viewer of cellar)
router.get('/:id', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle, cellar, cellarRole: role } = req;
    await bottle.populate(WINE_POPULATE);

    // Join the historical rate snapshot for the date this price was entered.
    // Exposed as priceCurrencyRates so the frontend needs no changes.
    const bottleObj = bottle.toObject();
    if (bottle.priceSetAt) {
      const date = bottle.priceSetAt.toISOString().slice(0, 10);
      const snapshot = await getSnapshotForDate(date);
      if (snapshot) bottleObj.priceCurrencyRates = snapshot.rates;
    }

    // Include the uploader's own pending image (pre-approval) so they see
    // it immediately on their bottle — other users see wine?.image after approval
    const pendingImg = await BottleImage.findOne({
      $or: [
        { bottle: bottle._id },
        { wineDefinition: bottle.wineDefinition }
      ],
      uploadedBy: req.user.id,
      status: { $in: ['uploaded', 'processing', 'processed'] }
    }).sort({ createdAt: -1 }).lean();

    const pendingImageUrl = pendingImg
      ? (pendingImg.processedUrl || pendingImg.originalUrl)
      : null;

    const ucEntry = cellar.userColors?.find(uc => uc.user.toString() === req.user.id.toString());
    res.json({ bottle: bottleObj, userRole: role, cellarColor: ucEntry?.color || null, pendingImageUrl });
  } catch (error) {
    console.error('Get bottle error:', error);
    res.status(500).json({ error: 'Failed to get bottle' });
  }
});

// PUT /api/bottles/:id - Update bottle (owner or editor)
router.put('/:id', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;

    if (req.body.purchaseUrl && !isSafeUrl(req.body.purchaseUrl)) {
      return res.status(400).json({ error: 'purchaseUrl must be a valid http or https URL' });
    }

    // Update allowed fields — diff old vs new for the audit log
    const updateFields = [
      'vintage', 'price', 'currency', 'bottleSize',
      'purchaseDate', 'purchaseLocation', 'purchaseUrl',
      'location', 'notes', 'rating', 'ratingScale',
      'drinkFrom', 'drinkBefore'
    ];

    // Normalize a value to a comparable string (handles Date objects vs ISO strings)
    const norm = v => {
      if (v === null || v === undefined || v === '') return '';
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        try { return new Date(v).toISOString().slice(0, 10); } catch { return v; }
      }
      return String(v);
    };

    const htmlFields = new Set(['purchaseLocation', 'location', 'notes']);
    const changes = {};
    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        const oldVal = bottle[field];
        const rawVal = req.body[field];
        const newVal = htmlFields.has(field) ? stripHtml(rawVal) : rawVal;
        if (norm(oldVal) !== norm(newVal)) {
          changes[field] = { from: oldVal ?? null, to: newVal !== '' ? newVal : null };
        }
        bottle[field] = newVal;
      }
    });

    // Validate and coerce rating if it was updated
    if ('rating' in req.body) {
      const { rating: r, ratingScale: rs, error: ratingError } = resolveRating(req.body.rating, bottle.ratingScale);
      if (ratingError) return res.status(400).json({ error: ratingError });
      bottle.rating = r;
      bottle.ratingScale = rs;
    }

    // Re-anchor the price date whenever price or currency is being updated,
    // and ensure today's rate snapshot exists for future lookups.
    if ('price' in req.body || 'currency' in req.body) {
      if (bottle.price !== null && bottle.price !== undefined) {
        bottle.priceSetAt = new Date();
        await getOrCreateDailySnapshot();
      } else {
        bottle.priceSetAt = undefined;
      }
    }

    await bottle.save();
    await bottle.populate(WINE_POPULATE);

    if (Object.keys(changes).length > 0) {
      logAudit(req, 'bottle.update',
        { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
        { changes }
      );
    }

    // If vintage changed, the old (wine, oldVintage) embedding is still in Qdrant
    // but won't match this bottle anymore (user changed the year). Embed the new pair.
    if (changes.vintage) {
      embedSinglePair(bottle.wineDefinition._id || bottle.wineDefinition, bottle.vintage).catch(() => {});
    }

    res.json({ bottle });
  } catch (error) {
    if (error.name === 'VersionError') {
      return res.status(409).json({ error: 'This bottle was modified by another request. Please refresh and try again.' });
    }
    console.error('Update bottle error:', error);
    res.status(500).json({ error: 'Failed to update bottle' });
  }
});

// POST /api/bottles/:id/consume - Soft-remove bottle (owner or editor)
router.post('/:id/consume', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;
    const { reason = 'drank', note, rating, consumedRatingScale } = req.body;

    if (!CONSUMED_STATUSES.includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason' });
    }

    const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumeRatingError } = resolveRating(rating, consumedRatingScale);
    if (consumeRatingError) return res.status(400).json({ error: consumeRatingError });

    // Remove from any rack slot so the slot is freed up
    await removeFromRacks(bottle._id);

    bottle.status = reason;
    bottle.consumedAt = new Date();
    bottle.consumedReason = reason;
    if (note) bottle.consumedNote = stripHtml(note);
    if (resolvedConsumedRating !== undefined) {
      bottle.consumedRating = resolvedConsumedRating;
      bottle.consumedRatingScale = resolvedConsumedScale;
    }

    await bottle.save();

    logAudit(req, 'bottle.consume',
      { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
      { reason }
    );

    res.json({ bottle });
  } catch (error) {
    console.error('Consume bottle error:', error);
    res.status(500).json({ error: 'Failed to consume bottle' });
  }
});

// DELETE /api/bottles/:id - Delete bottle (owner or editor)
router.delete('/:id', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;

    // Remove bottle from any rack slot that references it
    await removeFromRacks(bottle._id);

    logAudit(req, 'bottle.delete',
      { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
      {}
    );

    await bottle.deleteOne();
    res.json({ message: 'Bottle deleted successfully' });
  } catch (error) {
    console.error('Delete bottle error:', error);
    res.status(500).json({ error: 'Failed to delete bottle' });
  }
});

module.exports = router;
