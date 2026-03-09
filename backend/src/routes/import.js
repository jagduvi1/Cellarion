const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const Country = require('../models/Country');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const { resolveRating } = require('../utils/ratingUtils');
const { normalizeString, combinedSimilarity } = require('../utils/normalize');
const searchService = require('../services/search');
const { CONSUMED_STATUSES } = require('../config/constants');
const { stripHtml } = require('../utils/sanitize');
const WineRequest = require('../models/WineRequest');

const router = express.Router();
router.use(requireAuth);

// Maximum items per import batch
const MAX_IMPORT_SIZE = 500;

// Similarity thresholds
const EXACT_THRESHOLD = 0.95;
const FUZZY_THRESHOLD = 0.65;

/**
 * Score a WineDefinition candidate against an import item.
 * Returns a composite score (0–1) using name + producer weighted matching.
 */
function scoreCandidate(candidate, item) {
  const nameScore = combinedSimilarity(candidate.name, item.wineName);
  const producerScore = combinedSimilarity(candidate.producer, item.producer);

  // Weighted: name 0.45, producer 0.45, appellation bonus 0.10
  let score = nameScore * 0.45 + producerScore * 0.45;

  if (item.appellation && candidate.appellation) {
    score += combinedSimilarity(candidate.appellation, item.appellation) * 0.10;
  } else {
    // Redistribute appellation weight to name+producer when not available
    score += (nameScore * 0.05 + producerScore * 0.05);
  }

  return score;
}

/**
 * Find best wine matches for a single import item.
 * Strategy:
 *   1. Try Meilisearch fuzzy search (fast, covers typos)
 *   2. Fallback to MongoDB text search + normalized key lookup
 *   3. Score all candidates with combinedSimilarity
 */
async function findWineMatches(item) {
  const candidates = new Map(); // id -> { wine, score }

  // Strategy 1: Meilisearch search (if available)
  if (searchService.getIsAvailable()) {
    try {
      // Search with combined producer + name for best fuzzy results
      const query = `${item.producer || ''} ${item.wineName || ''}`.trim();
      const searchOpts = { limit: 15 };

      // Add country filter if we can resolve it
      if (item.country) {
        const normalizedCountry = normalizeString(item.country);
        const countryDoc = await Country.findOne({ normalizedName: normalizedCountry }).lean();
        if (countryDoc) searchOpts.countryId = countryDoc._id.toString();
      }

      const { ids } = await searchService.search(query, searchOpts);
      if (ids.length > 0) {
        const wines = await WineDefinition.find({ _id: { $in: ids } })
          .populate(['country', 'region', 'grapes'])
          .lean();

        for (const wine of wines) {
          const score = scoreCandidate(wine, item);
          if (score >= FUZZY_THRESHOLD) {
            candidates.set(wine._id.toString(), { wine, score });
          }
        }
      }
    } catch {
      // Meilisearch unavailable, fall through to MongoDB
    }
  }

  // Strategy 2: MongoDB text search fallback
  if (candidates.size < 3) {
    try {
      const searchTerms = `${item.producer || ''} ${item.wineName || ''}`.trim();
      if (searchTerms) {
        const mongoWines = await WineDefinition.find(
          { $text: { $search: searchTerms } },
          { score: { $meta: 'textScore' } }
        )
          .populate(['country', 'region', 'grapes'])
          .sort({ score: { $meta: 'textScore' } })
          .limit(10)
          .lean();

        for (const wine of mongoWines) {
          const id = wine._id.toString();
          if (!candidates.has(id)) {
            const score = scoreCandidate(wine, item);
            if (score >= FUZZY_THRESHOLD) {
              candidates.set(id, { wine, score });
            }
          }
        }
      }
    } catch {
      // Text index may not exist, continue
    }
  }

  // Strategy 3: Direct normalized name/producer lookup
  if (candidates.size < 3 && item.producer && item.wineName) {
    const normalizedProducer = normalizeString(item.producer);
    const normalizedName = normalizeString(item.wineName);

    const directMatches = await WineDefinition.find({
      $or: [
        { normalizedKey: { $regex: `^${normalizedProducer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:` } },
        { normalizedKey: { $regex: `:${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:` } }
      ]
    })
      .populate(['country', 'region', 'grapes'])
      .limit(20)
      .lean();

    for (const wine of directMatches) {
      const id = wine._id.toString();
      if (!candidates.has(id)) {
        const score = scoreCandidate(wine, item);
        if (score >= FUZZY_THRESHOLD) {
          candidates.set(id, { wine, score });
        }
      }
    }
  }

  // Sort by score descending, return top 5
  const sorted = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return sorted;
}

/**
 * POST /api/bottles/import/validate
 *
 * Accepts an array of bottles in master import format.
 * Returns match results for each item with wine candidates.
 *
 * Body: { cellarId, items: [{ wineName, producer, country, ... }] }
 * Response: { results: [{ index, item, status, matches: [{ wine, score }] }] }
 */
router.post('/validate', async (req, res) => {
  try {
    const { cellarId, items } = req.body;

    if (!cellarId) {
      return res.status(400).json({ error: 'cellarId is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Invalid cellarId' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required and must not be empty' });
    }
    if (items.length > MAX_IMPORT_SIZE) {
      return res.status(400).json({ error: `Maximum ${MAX_IMPORT_SIZE} items per import` });
    }

    // Verify cellar access
    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellar, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to import bottles to this cellar' });
    }

    const results = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Validate required fields
      if (!item.wineName && !item.producer) {
        results.push({
          index: i,
          item,
          status: 'error',
          error: 'Wine name or producer is required',
          matches: []
        });
        continue;
      }

      const matches = await findWineMatches(item);

      let status;
      if (matches.length === 0) {
        status = 'no_match';
      } else if (matches[0].score >= EXACT_THRESHOLD) {
        status = 'exact';
      } else {
        status = 'fuzzy';
      }

      results.push({
        index: i,
        item,
        status,
        matches: matches.map(m => ({
          wineId: m.wine._id,
          name: m.wine.name,
          producer: m.wine.producer,
          country: m.wine.country?.name || null,
          region: m.wine.region?.name || null,
          appellation: m.wine.appellation || null,
          type: m.wine.type,
          image: m.wine.image || null,
          score: Math.round(m.score * 100) / 100
        }))
      });
    }

    res.json({
      cellarId,
      results,
      summary: {
        total: results.length,
        exact: results.filter(r => r.status === 'exact').length,
        fuzzy: results.filter(r => r.status === 'fuzzy').length,
        noMatch: results.filter(r => r.status === 'no_match').length,
        errors: results.filter(r => r.status === 'error').length
      }
    });
  } catch (error) {
    console.error('Import validate error:', error);
    res.status(500).json({ error: 'Validation failed' });
  }
});

/**
 * POST /api/bottles/import/confirm
 *
 * Creates bottles for validated import items.
 * Each item must have a confirmed wineDefinition ID.
 *
 * Body: { cellarId, items: [{ wineDefinition, vintage, price, currency, ... }] }
 * Response: { created, skipped, errors[] }
 */
router.post('/confirm', async (req, res) => {
  try {
    const { cellarId, items } = req.body;

    if (!cellarId) {
      return res.status(400).json({ error: 'cellarId is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Invalid cellarId' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required and must not be empty' });
    }
    if (items.length > MAX_IMPORT_SIZE) {
      return res.status(400).json({ error: `Maximum ${MAX_IMPORT_SIZE} items per import` });
    }

    // Verify cellar access
    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellar, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to import bottles to this cellar' });
    }

    // Ensure exchange rate snapshot exists if any items have prices
    const hasPrice = items.some(i => i.price != null && i.price !== '');
    if (hasPrice) {
      await getOrCreateDailySnapshot().catch(() => {});
    }

    let created = 0;
    const skipped = [];
    const errors = [];
    // Dedup map: "wineName|producer" -> WineRequest doc created in this batch
    const pendingRequestCache = new Map();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (!item.wineDefinition && !item.requestWine) {
        skipped.push({ index: i, reason: 'No wine selected' });
        continue;
      }

      try {
        let wineDoc = null;

        if (item.requestWine) {
          // No match — create a pending WineRequest and bottle without wineDefinition
          if (!item.wineName && !item.producer) {
            errors.push({ index: i, reason: 'Wine name or producer is required' });
            continue;
          }

          const requestKey = `${(item.wineName || '').trim().toLowerCase()}|${(item.producer || '').trim().toLowerCase()}`;
          let wineRequest = pendingRequestCache.get(requestKey);

          if (!wineRequest) {
            wineRequest = new WineRequest({
              requestType: 'new_wine',
              wineName: (item.wineName || item.producer || '').trim(),
              producer: (item.producer || '').trim() || undefined,
              user: req.user.id,
              status: 'pending'
            });
            await wineRequest.save();
            pendingRequestCache.set(requestKey, wineRequest);
          }

          // Validate consumed rating if adding to history
          const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumeRatingError } =
            item.addToHistory ? resolveRating(item.consumedRating, item.consumedRatingScale) : { rating: undefined, ratingScale: undefined, error: null };
          if (consumeRatingError) {
            errors.push({ index: i, reason: consumeRatingError });
            continue;
          }

          if (item.addToHistory && item.consumedReason && !CONSUMED_STATUSES.includes(item.consumedReason)) {
            errors.push({ index: i, reason: 'Invalid consumed reason' });
            continue;
          }

          const priceSetAt = (item.price != null && item.price !== '') ? new Date() : undefined;

          const bottle = new Bottle({
            cellar: cellarId,
            user: cellar.user,
            pendingWineRequest: wineRequest._id,
            vintage: item.vintage || 'NV',
            price: item.price || undefined,
            currency: item.currency || 'USD',
            priceSetAt,
            bottleSize: item.bottleSize || '750ml',
            purchaseDate: item.purchaseDate || undefined,
            purchaseLocation: stripHtml(item.purchaseLocation),
            location: stripHtml(item.location),
            notes: stripHtml(item.notes),
            drinkFrom: item.drinkFrom || undefined,
            drinkBefore: item.drinkBefore || undefined
          });

          if (item.dateAdded) bottle.createdAt = new Date(item.dateAdded);

          if (item.addToHistory) {
            const reason = item.consumedReason || 'drank';
            bottle.status = reason;
            bottle.consumedReason = reason;
            bottle.consumedAt = item.consumedAt ? new Date(item.consumedAt) : new Date();
            if (item.consumedNote) bottle.consumedNote = stripHtml(item.consumedNote);
            if (resolvedConsumedRating !== undefined) {
              bottle.consumedRating = resolvedConsumedRating;
              bottle.consumedRatingScale = resolvedConsumedScale;
            }
          }

          await bottle.save();
          created++;
          continue;
        }

        // Verify wine definition exists
        if (!mongoose.Types.ObjectId.isValid(item.wineDefinition)) {
          errors.push({ index: i, reason: 'Invalid wine definition ID' });
          continue;
        }
        wineDoc = await WineDefinition.findById(item.wineDefinition);
        if (!wineDoc) {
          errors.push({ index: i, reason: 'Wine definition not found' });
          continue;
        }

        // Validate rating if provided
        const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } =
          resolveRating(item.rating, item.ratingScale);
        if (ratingError) {
          errors.push({ index: i, reason: ratingError });
          continue;
        }

        // Validate consumed rating if adding to history
        const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumeRatingError } =
          item.addToHistory ? resolveRating(item.consumedRating, item.consumedRatingScale) : { rating: undefined, ratingScale: undefined, error: null };
        if (consumeRatingError) {
          errors.push({ index: i, reason: consumeRatingError });
          continue;
        }

        if (item.addToHistory && item.consumedReason && !CONSUMED_STATUSES.includes(item.consumedReason)) {
          errors.push({ index: i, reason: 'Invalid consumed reason' });
          continue;
        }

        const priceSetAt = (item.price != null && item.price !== '')
          ? new Date()
          : undefined;

        const bottle = new Bottle({
          cellar: cellarId,
          user: cellar.user,
          wineDefinition: item.wineDefinition,
          vintage: item.vintage || 'NV',
          price: item.price || undefined,
          currency: item.currency || 'USD',
          priceSetAt,
          bottleSize: item.bottleSize || '750ml',
          purchaseDate: item.purchaseDate || undefined,
          purchaseLocation: stripHtml(item.purchaseLocation),
          location: stripHtml(item.location),
          notes: stripHtml(item.notes),
          rating: resolvedRating,
          ratingScale: resolvedScale,
          drinkFrom: item.drinkFrom || undefined,
          drinkBefore: item.drinkBefore || undefined
        });

        // Allow backdating
        if (item.dateAdded) bottle.createdAt = new Date(item.dateAdded);

        // Allow adding directly to history
        if (item.addToHistory) {
          const reason = item.consumedReason || 'drank';
          bottle.status = reason;
          bottle.consumedReason = reason;
          bottle.consumedAt = item.consumedAt ? new Date(item.consumedAt) : new Date();
          if (item.consumedNote) bottle.consumedNote = stripHtml(item.consumedNote);
          if (resolvedConsumedRating !== undefined) {
            bottle.consumedRating = resolvedConsumedRating;
            bottle.consumedRatingScale = resolvedConsumedScale;
          }
        }

        await bottle.save();
        created++;

        // Place bottle in rack if rackName + rackPosition provided (active bottles only)
        if (item.rackName && item.rackPosition && bottle.status === 'active') {
          try {
            const position = parseInt(item.rackPosition, 10);
            if (!isNaN(position) && position >= 1) {
              const rack = await Rack.findOne({ cellar: cellarId, name: String(item.rackName), deletedAt: null });
              if (rack && position <= rack.rows * rack.cols) {
                // Only place if slot is empty
                const occupied = rack.slots.some(s => s.position === position);
                if (!occupied) {
                  rack.slots.push({ position, bottle: bottle._id });
                  await rack.save().catch(() => {});
                }
              }
            }
          } catch {
            // Non-fatal: bottle was still created
          }
        }

        // Auto-create pending WineVintageProfile for numeric vintages
        const vintageYear = parseInt(item.vintage);
        if (item.vintage && item.vintage !== 'NV' && !isNaN(vintageYear)) {
          const wineDefId = wineDoc._id;
          WineVintageProfile.findOneAndUpdate(
            { wineDefinition: wineDefId, vintage: String(vintageYear) },
            { $setOnInsert: { wineDefinition: wineDefId, vintage: String(vintageYear), status: 'pending' } },
            { upsert: true, new: false }
          ).catch(() => {});
        }
      } catch (err) {
        errors.push({ index: i, reason: err.message });
      }
    }

    logAudit(req, 'bottle.import', { type: 'cellar', id: cellarId }, {
      created,
      skipped: skipped.length,
      errors: errors.length,
      total: items.length
    });

    res.json({
      created,
      skipped,
      errors,
      total: items.length
    });
  } catch (error) {
    console.error('Import confirm error:', error);
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
