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
const { normalizeString } = require('../utils/normalize');
const searchService = require('../services/search');
const { identifyWineFromText } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { scoreWineMatch } = require('../services/wineMatching');
const {
  CONSUMED_STATUSES,
  IMPORT_EXACT_THRESHOLD,
  IMPORT_FUZZY_THRESHOLD,
  MAX_IMPORT_SIZE,
  AI_CONCURRENCY,
} = require('../config/constants');
const { stripHtml } = require('../utils/sanitize');
const { extractAiExplanation } = require('../utils/jsonExtract');
const { getMaxPosition } = require('../utils/rackGeometry');
const { runConcurrent } = require('../utils/concurrency');
const WineRequest = require('../models/WineRequest');
const ImportSession = require('../models/ImportSession');

const router = express.Router();
router.use(requireAuth);

// Aliases for readability (imported from config/constants.js)
const EXACT_THRESHOLD = IMPORT_EXACT_THRESHOLD;
const FUZZY_THRESHOLD = IMPORT_FUZZY_THRESHOLD;

/**
 * Score a WineDefinition candidate against an import item.
 * Delegates to the shared wineMatching service.
 */
function scoreCandidate(candidate, item) {
  return scoreWineMatch(candidate, {
    name: item.wineName,
    producer: item.producer,
    appellation: item.appellation
  });
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
    } catch (err) {
      console.error('Meilisearch search failed during import, falling back to MongoDB:', err.message);
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
    } catch (err) {
      console.error('MongoDB text search failed during import (text index may not exist):', err.message);
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

    const isAdmin = req.user.roles && req.user.roles.includes('admin');

    // Build preResults array and validate required fields
    const preResults = [];
    for (let i = 0; i < items.length; i++) {
      const { forceAi, ...item } = items[i];
      if (!item.wineName && !item.producer) {
        preResults.push({ index: i, item, errorMsg: 'Wine name or producer is required' });
      } else {
        preResults.push({ index: i, item, matches: [] });
      }
    }

    // Pass 1: AI identification FIRST for all valid items (deduplicated).
    // AI is better at distinguishing similar wines (e.g. single vineyard vs
    // generic Barolo) so it runs before fuzzy matching to produce accurate
    // wine identity data that the DB match can then use.
    const aiEligible = process.env.ANTHROPIC_API_KEY
      ? preResults.filter(pr => !pr.errorMsg && pr.item.wineName && pr.item.producer)
      : [];

    // Build unique wine keys — one AI call per unique wine, not per bottle
    const aiKeyMap = new Map(); // normalizedKey -> preResult (representative)
    for (const pr of aiEligible) {
      const key = `${normalizeString(pr.item.wineName)}:${normalizeString(pr.item.producer)}`;
      if (!aiKeyMap.has(key)) aiKeyMap.set(key, pr);
    }

    // One AI call per unique wine, throttled to AI_CONCURRENCY at a time
    const uniquePrs = [...aiKeyMap.values()];
    const aiSettled = await runConcurrent(
      uniquePrs.map(pr => () => identifyWineFromText({
        name: pr.item.wineName,
        producer: pr.item.producer,
        vintage: pr.item.vintage,
        country: pr.item.country
      })),
      AI_CONCURRENCY
    );

    // Build a key -> AI result lookup
    const aiByKey = new Map();
    for (let j = 0; j < uniquePrs.length; j++) {
      const key = `${normalizeString(uniquePrs[j].item.wineName)}:${normalizeString(uniquePrs[j].item.producer)}`;
      aiByKey.set(key, aiSettled[j]);
    }

    // Attach the shared AI result to every eligible preResult with that key
    for (const pr of aiEligible) {
      const key = `${normalizeString(pr.item.wineName)}:${normalizeString(pr.item.producer)}`;
      const settled = aiByKey.get(key);
      if (settled.status === 'fulfilled') {
        pr.aiIdentified = settled.value.data;
        pr.aiDebugRaw    = settled.value.debugRaw;
        pr.aiDebugReason = settled.value.debugReason;
      } else {
        pr.aiError = settled.reason?.message;
      }
    }

    // Pass 2: create/find wines for AI-identified items, deduplicated by wine key.
    // findOrCreateWine internally does fuzzy matching using the AI-refined
    // name/producer, which is more accurate than matching raw import data.
    const createdWineCache = new Map(); // normalizedKey -> { wine, created } | { error }
    for (const pr of preResults) {
      if (!pr.aiIdentified) continue;
      const key = `${normalizeString(pr.aiIdentified.name)}:${normalizeString(pr.aiIdentified.producer)}`;
      if (createdWineCache.has(key)) {
        const cached = createdWineCache.get(key);
        if (cached.wine) { pr.aiWine = cached.wine; pr.aiWineCreated = false; }
        else pr.aiWineError = cached.error;
      } else {
        try {
          const { wine, created } = await findOrCreateWine(pr.aiIdentified, req.user.id);
          createdWineCache.set(key, { wine, created });
          pr.aiWine = wine;
          pr.aiWineCreated = created;
        } catch (err) {
          createdWineCache.set(key, { error: err.message });
          pr.aiWineError = err.message;
        }
      }
    }

    // Pass 3: fuzzy matching fallback for items without AI results
    // (API key not set, AI failed, or missing name/producer for AI)
    for (const pr of preResults) {
      if (pr.errorMsg || pr.aiWine) continue; // skip errors and AI-matched items
      const matches = await findWineMatches(pr.item);
      pr.matches = matches;
    }

    // Pass 4: build final results
    const results = [];
    for (const pr of preResults) {
      if (pr.errorMsg) {
        results.push({ index: pr.index, item: pr.item, status: 'error', error: pr.errorMsg, matches: [] });
        continue;
      }

      let status, resultMatches, aiDebug = null;

      if (pr.aiWine) {
        // AI successfully identified and found/created the wine
        status = 'ai_match';
        resultMatches = [{
          wineId: pr.aiWine._id,
          name: pr.aiWine.name,
          producer: pr.aiWine.producer,
          country: pr.aiWine.country?.name || null,
          region: pr.aiWine.region?.name || null,
          appellation: pr.aiWine.appellation || null,
          type: pr.aiWine.type,
          image: pr.aiWine.image || null,
          score: pr.aiIdentified.confidence ?? 1,
          aiIdentified: true
        }];
      } else if (pr.matches.length > 0) {
        // AI failed or unavailable, but fuzzy matching found candidates
        const { matches } = pr;
        if (matches[0].score >= EXACT_THRESHOLD) {
          status = 'exact';
        } else {
          status = 'fuzzy';
        }
        resultMatches = matches.map(m => ({
          wineId: m.wine._id,
          name: m.wine.name,
          producer: m.wine.producer,
          country: m.wine.country?.name || null,
          region: m.wine.region?.name || null,
          appellation: m.wine.appellation || null,
          type: m.wine.type,
          image: m.wine.image || null,
          score: Math.round(m.score * 100) / 100
        }));
      } else {
        // No match from either AI or fuzzy
        status = 'no_match';
        resultMatches = [];

        // Include AI debug info when AI was attempted but failed
        if (process.env.ANTHROPIC_API_KEY && (pr.item.wineName || pr.item.producer)) {
          const aiStatus = pr.aiError || pr.aiDebugReason === 'rate_limit_exceeded' ||
            (pr.aiDebugReason && pr.aiDebugReason.startsWith('exception'))
            ? 'failed' : (pr.aiWineError ? 'create_failed' : 'searched');
          const aiExplanation = aiStatus === 'create_failed' && pr.aiWineError
            ? pr.aiWineError
            : extractAiExplanation(pr.aiDebugRaw);
          aiDebug = { aiStatus, ...(aiExplanation && { aiExplanation }) };
        }
      }

      const result = { index: pr.index, item: pr.item, status, matches: resultMatches };
      if (aiDebug) result.aiDebug = aiDebug;
      results.push(result);
    }

    res.json({
      cellarId,
      results,
      summary: {
        total: results.length,
        exact: results.filter(r => r.status === 'exact').length,
        fuzzy: results.filter(r => r.status === 'fuzzy').length,
        aiMatch: results.filter(r => r.status === 'ai_match').length,
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
      await getOrCreateDailySnapshot().catch(err => console.error('Failed to fetch daily exchange rate snapshot:', err.message));
    }

    let created = 0;
    const skipped = [];
    const errors = [];
    const createdBottleIds = []; // Track IDs for Meilisearch bulk sync
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
            notes: stripHtml(item.notes)
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
          if (!item.addToHistory) createdBottleIds.push(bottle._id);
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
          ratingScale: resolvedScale
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
        if (!item.addToHistory) createdBottleIds.push(bottle._id);

        // Place bottle in rack if rackName + rackPosition provided (active bottles only)
        if (item.rackName && item.rackPosition && bottle.status === 'active') {
          try {
            const position = parseInt(item.rackPosition, 10);
            if (!isNaN(position) && position >= 1) {
              const rack = await Rack.findOne({ cellar: cellarId, name: String(item.rackName), deletedAt: null });
              if (rack && position <= getMaxPosition(rack)) {
                // Only place if slot is empty
                const occupied = rack.slots.some(s => s.position === position);
                if (!occupied) {
                  rack.slots.push({ position, bottle: bottle._id });
                  await rack.save().catch(err => console.error('Failed to save rack slot during import:', err.message));
                }
              }
            }
          } catch (err) {
            console.error('Failed to place bottle in rack during import (non-fatal):', err.message);
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
          ).catch(err => console.error('Failed to upsert WineVintageProfile during import:', err.message));
        }
      } catch (err) {
        errors.push({ index: i, reason: err.message });
      }
    }

    // Bulk-index created bottles in Meilisearch (fire-and-forget)
    searchService.bulkIndexBottles(createdBottleIds);

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

// ─── Import Session routes ────────────────────────────────────────────────────
//
// POST   /api/bottles/import/sessions         – create (or replace) draft session
// GET    /api/bottles/import/sessions?cellarId – list draft sessions for a cellar
// GET    /api/bottles/import/sessions/:id      – load session; refreshes 'request' items
// PUT    /api/bottles/import/sessions/:id      – update selections/manualWines
// DELETE /api/bottles/import/sessions/:id      – delete session

/**
 * POST /api/bottles/import/sessions
 *
 * Creates (or replaces) the user's draft session for a cellar.
 * One draft per user+cellar — the old one is deleted before creating the new one
 * so stale sessions don't accumulate.
 */
router.post('/sessions', async (req, res) => {
  try {
    const { cellarId, fileName, detectedFormat, results, selections, manualWines } = req.body;

    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellarId is required' });
    }
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'results array is required' });
    }

    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellar, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Replace any existing draft for this user+cellar
    await ImportSession.deleteMany({ cellar: cellarId, user: req.user.id, status: 'draft' });

    const session = new ImportSession({
      cellar: cellarId,
      user: req.user.id,
      fileName,
      detectedFormat,
      results,
      selections: selections || {},
      manualWines: manualWines || {}
    });
    await session.save();

    res.status(201).json({ sessionId: session._id });
  } catch (err) {
    console.error('Create import session error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

/**
 * GET /api/bottles/import/sessions?cellarId=...
 *
 * Lists draft sessions for the authenticated user in a cellar.
 */
router.get('/sessions', async (req, res) => {
  try {
    const { cellarId } = req.query;
    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellarId is required' });
    }

    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    if (!getCellarRole(cellar, req.user.id)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const sessions = await ImportSession.find({
      cellar: cellarId,
      user: req.user.id,
      status: 'draft'
    })
      .select('fileName detectedFormat createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ sessions });
  } catch (err) {
    console.error('List import sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/bottles/import/sessions/:id
 *
 * Loads a draft session.  For any item whose selection is 'request', re-runs wine
 * matching — if a wine has since been added to the library (e.g. admin resolved the
 * request), the new match is returned in `refreshed` so the frontend can update the
 * selection automatically.
 */
router.get('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id).lean();
    if (!session || session.status !== 'draft') {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Re-match items that were marked 'request' to detect wines added since last save
    const refreshed = {}; // { [index]: match object }
    const requestedIndices = Object.entries(session.selections || {})
      .filter(([, sel]) => sel === 'request')
      .map(([idx]) => Number(idx));

    for (const idx of requestedIndices) {
      const result = (session.results || []).find(r => r.index === idx);
      if (!result?.item) continue;
      try {
        const matches = await findWineMatches(result.item);
        if (matches.length > 0 && matches[0].score >= EXACT_THRESHOLD) {
          const m = matches[0];
          refreshed[idx] = {
            wineId: m.wine._id,
            name: m.wine.name,
            producer: m.wine.producer,
            country: m.wine.country?.name || null,
            region: m.wine.region?.name || null,
            appellation: m.wine.appellation || null,
            type: m.wine.type,
            score: Math.round(m.score * 100) / 100
          };
        }
      } catch (err) {
        console.error('Failed to re-match import session item (non-fatal):', err.message);
      }
    }

    res.json({ session, refreshed });
  } catch (err) {
    console.error('Load import session error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

/**
 * PUT /api/bottles/import/sessions/:id
 *
 * Updates selections and/or manualWines for an existing draft session.
 */
router.put('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id);
    if (!session || session.status !== 'draft') {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { selections, manualWines } = req.body;
    if (selections !== undefined) session.selections = selections;
    if (manualWines !== undefined) session.manualWines = manualWines;
    await session.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('Update import session error:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

/**
 * DELETE /api/bottles/import/sessions/:id
 *
 * Deletes a session (called after a successful import).
 */
router.delete('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await session.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete import session error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

module.exports = router;
