const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireBottleAccess } = require('../middleware/bottleAccess');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const WineVintageProfile = require('../models/WineVintageProfile');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getOrCreateDailySnapshot, getSnapshotForDate } = require('../utils/exchangeRates');
const { resolveRating } = require('../utils/ratingUtils');
const { embedSinglePair } = require('../services/embeddingJob');
const { enrichWineById } = require('../services/enrichmentJob');
const { CONSUMED_STATUSES, WINE_POPULATE, WINE_POPULATE_LIST } = require('../config/constants');
const { checkRestockGap, resolveRestockAlerts } = require('../services/restockChecker');
const { gatherPriceWarnings } = require('../services/priceWarnings');
const { getCurrentRelease } = require('../services/communityPrice');
const { stripHtml, isSafeUrl, escapeRegex } = require('../utils/sanitize');
const { parseAndValidateVintage } = require('../utils/validation');
const { normalizeBottleSize, DEFAULT_SIZE } = require('../config/bottleSizes');
const { toNormalized } = require('../utils/ratingUtils');
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
const { parsePagination } = require('../utils/pagination');
const mongoose = require('mongoose');
const searchService = require('../services/search');

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

// GET /api/bottles — list the authenticated user's active bottles across all
// cellars they OWN (shared/read-only cellars are excluded, matching the
// Statistics page's scope so the deep-links from Statistics chart segments
// land on a bottle set with matching counts).
//
// Supported filter query params (all optional, combinable):
//   search       — free-text match against wine name / producer / notes / location / type / appellation / grape names
//   type         — wine type enum, comma-separated allowed
//   country      — country ID, comma-separated allowed
//   region       — region ID, comma-separated allowed
//   grapes       — grape ID, comma-separated
//   vintage      — vintage year string, comma-separated
//   producer     — exact producer string (case-insensitive)
//   bottleSize   — exact bottle-size string (e.g. "750ml")
//   minRating    — minimum normalised rating (0-100)
//   maturity     — one of 'declining','late','peak','early','not-ready','none'
//   sort         — 'createdAt'|'vintage'|'price'|'rating'|'name'|'maturity' with optional leading '-' for descending
//   limit / offset — pagination (defaults: limit 30, max 200)
router.get('/', async (req, res) => {
  try {
    const { isValidObjectId } = mongoose;

    const cellarIds = await Cellar.find({ user: req.user.id, deletedAt: null }).distinct('_id');
    const { limit, offset: skip } = parsePagination(req.query, { limit: 30, maxLimit: 200 });

    if (cellarIds.length === 0) {
      return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
    }

    // Defensive scalar coercion: Express's qs query parser turns inputs
    // like `?bottleSize[$ne]=1` into `{ bottleSize: { $ne: '1' } }`,
    // which would bypass per-field guards and leak Mongo operators into
    // the filter we build below. Reject anything that isn't a plain
    // string so every value below is guaranteed to be primitive.
    const q = (v) => (typeof v === 'string' ? v : undefined);
    const search           = q(req.query.search);
    const type             = q(req.query.type);
    const country          = q(req.query.country);
    const region           = q(req.query.region);
    const grapes           = q(req.query.grapes);
    const vintage          = q(req.query.vintage);
    const producer         = q(req.query.producer);
    const bottleSize       = q(req.query.bottleSize);
    const minRating        = q(req.query.minRating);
    const maturityFilter   = q(req.query.maturity);
    const sort             = q(req.query.sort) || '-createdAt';
    // Lifecycle filters — default is active-only, matching the
    // Statistics page's by-type / by-country / etc. aggregates.
    const statusFilter     = q(req.query.status);
    // Purchase / consumption year filters apply to bottle.purchaseDate
    // and bottle.consumedAt respectively — driven by the Statistics
    // page's Purchase History and Consumption History charts.
    const purchaseYear     = q(req.query.purchaseYear);
    const consumedYear     = q(req.query.consumedYear);

    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    const sortDir = sort.startsWith('-') ? -1 : 1;

    const filter = {
      user: req.user.id,
      cellar: { $in: cellarIds },
    };

    // Status / lifecycle scope
    if (!statusFilter || statusFilter === 'active') {
      filter.status = { $nin: CONSUMED_STATUSES };
    } else if (statusFilter === 'all') {
      // no status constraint — include everything
    } else if (CONSUMED_STATUSES.includes(statusFilter)) {
      filter.status = statusFilter;
    } else if (statusFilter === 'consumed') {
      filter.status = { $in: CONSUMED_STATUSES };
    } else {
      // Unknown value — fall back to the default active scope
      filter.status = { $nin: CONSUMED_STATUSES };
    }

    if (vintage) {
      const vintages = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
      filter.vintage = vintages.length === 1 ? vintages[0] : { $in: vintages };
    }

    if (bottleSize) {
      filter.bottleSize = String(bottleSize);
    }

    // Year-range filters on purchaseDate / consumedAt. Using $gte/$lt of
    // Jan 1 of the year and Jan 1 of next year lets MongoDB use the
    // existing date indexes and avoids JS-side getFullYear() iteration.
    const yearRange = (yearStr) => {
      const y = parseInt(yearStr, 10);
      if (isNaN(y) || y < 1900 || y > 2200) return null;
      return { $gte: new Date(y, 0, 1), $lt: new Date(y + 1, 0, 1) };
    };

    if (purchaseYear) {
      const range = yearRange(purchaseYear);
      if (range) filter.purchaseDate = range;
    }
    if (consumedYear) {
      const range = yearRange(consumedYear);
      if (range) filter.consumedAt = range;
    }

    // Pre-query WineDefinition for taxonomy / type / producer filters.
    // country/region values may be ObjectIds OR display names — the
    // Statistics charts only know names (the byCountry/byRegion stats
    // aggregate by name), so we resolve names to IDs on the fly here
    // so the same query param works from both worlds.
    const wdFilter = {};

    const resolveTaxonomy = async (raw, Model) => {
      const ids = [];
      const names = [];
      for (const v of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
        if (isValidObjectId(v)) ids.push(v);
        else names.push(v);
      }
      if (names.length > 0) {
        const found = await Model.find({ name: { $in: names } }).distinct('_id');
        ids.push(...found.map(id => id.toString()));
      }
      return ids;
    };

    if (country) {
      const ids = await resolveTaxonomy(country, Country);
      if (ids.length === 0) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      wdFilter.country = ids.length === 1 ? ids[0] : { $in: ids };
    }
    if (region) {
      const ids = await resolveTaxonomy(region, Region);
      if (ids.length === 0) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      wdFilter.region = ids.length === 1 ? ids[0] : { $in: ids };
    }
    // Grapes can also be passed as names (the byGrape stat is a name list)
    if (grapes) {
      const grapeIds2 = await resolveTaxonomy(grapes, Grape);
      if (grapeIds2.length === 0) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      wdFilter.grapes = grapeIds2.length === 1 ? grapeIds2[0] : { $in: grapeIds2 };
    }
    // 'unknown' is the stats bucket for bottles WITHOUT a wine definition
    // (typically pending wine requests from an import) — no WineDefinition
    // ever has that type, so it must match null-wineDefinition bottles
    // instead of going into the wd pre-query.
    let includeNoWine = false;
    if (type) {
      const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
      includeNoWine = types.includes('unknown');
      const realTypes = types.filter(t => t !== 'unknown');
      if (realTypes.length > 0) {
        wdFilter.type = realTypes.length === 1 ? realTypes[0] : { $in: realTypes };
      }
    }
    if (producer) {
      // Producer is a free-text field on WineDefinition; match case-insensitively
      // with an anchored regex so chart segments that pass the exact value
      // (e.g. "Château Margaux") find that producer's bottles.
      const escaped = escapeRegex(producer);
      wdFilter.producer = new RegExp(`^${escaped}$`, 'i');
    }

    if (Object.keys(wdFilter).length > 0) {
      const wdIds = await WineDefinition.find(wdFilter).distinct('_id');
      if (wdIds.length === 0 && !includeNoWine) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      // $in with null matches bottles whose wineDefinition is null or absent.
      filter.wineDefinition = includeNoWine ? { $in: [...wdIds, null] } : { $in: wdIds };
    } else if (includeNoWine) {
      filter.wineDefinition = null;
    }

    const directSortFields = ['createdAt', 'vintage', 'price', 'rating'];
    const canSortInDb = directSortFields.includes(sortField);
    const needsInMemoryFilter = !!(search || minRating || maturityFilter);
    const canPaginateInDb = canSortInDb && !needsInMemoryFilter;

    let query = Bottle.find(filter).populate(WINE_POPULATE_LIST);
    if (canSortInDb) query = query.sort({ [sortField]: sortDir });
    if (canPaginateInDb) query = query.skip(skip).limit(limit);
    let bottles = await query.lean();
    let totalCount = canPaginateInDb ? await Bottle.countDocuments(filter) : null;

    // ── In-memory text search (multi-word AND across populated fields) ─────────
    if (search) {
      const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const words = stripAccents(String(search).toLowerCase()).split(/\s+/).filter(Boolean);
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
          ...(b.wineDefinition?.grapes || []).map(g => g.name),
        ].filter(Boolean).map(s => stripAccents(String(s).toLowerCase())).join(' ');
        return words.every(word => allText.includes(word));
      });
    }

    // ── Min-rating post-filter (rating scales must be normalised) ──────────────
    if (minRating) {
      const min = parseFloat(minRating);
      if (!isNaN(min)) {
        bottles = bottles.filter(b => {
          if (b.rating == null) return false;
          return toNormalized(b.rating, b.ratingScale || '5') >= min;
        });
      }
    }

    // ── Maturity post-filter / sort (needs WineVintageProfile lookup) ─────────
    let maturityMap = null;
    const needsMaturity = !!(maturityFilter || sortField === 'maturity');
    if (needsMaturity) {
      const profileMap = await buildProfileMap(bottles);
      maturityMap = new Map();
      for (const b of bottles) {
        maturityMap.set(b._id.toString(), classifyMaturity(b, profileMap));
      }
    }

    if (maturityFilter && maturityMap) {
      if (maturityFilter === 'none') {
        bottles = bottles.filter(b => maturityMap.get(b._id.toString()) == null);
      } else {
        bottles = bottles.filter(b => maturityMap.get(b._id.toString()) === maturityFilter);
      }
    }

    // ── In-memory sort for fields we couldn't sort in the DB ──────────────────
    if (!canSortInDb) {
      const MATURITY_RANK = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };
      bottles.sort((a, b) => {
        let aVal, bVal;
        if (sortField === 'name') {
          aVal = a.wineDefinition?.name || '';
          bVal = b.wineDefinition?.name || '';
        } else if (sortField === 'maturity' && maturityMap) {
          const aStatus = maturityMap.get(a._id.toString());
          const bStatus = maturityMap.get(b._id.toString());
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

    if (!canPaginateInDb) {
      totalCount = bottles.length;
      bottles = bottles.slice(skip, skip + limit);
    }

    const items = bottles.map(b => ({
      ...b,
      ...(maturityMap ? { maturityStatus: maturityMap.get(b._id.toString()) || null } : {}),
    }));

    res.json({
      bottles: {
        count: items.length,
        total: totalCount,
        limit,
        skip,
        items,
      },
    });
  } catch (err) {
    console.error('GET /api/bottles error:', err);
    res.status(500).json({ error: 'Failed to load bottles' });
  }
});

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

    const vintageCheck = parseAndValidateVintage(vintage);
    if (!vintageCheck.ok) return res.status(400).json({ error: vintageCheck.error });
    const canonicalVintage = vintageCheck.value;

    if (purchaseUrl) {
      if (purchaseUrl.length > 2048) return res.status(400).json({ error: 'purchaseUrl is too long (max 2048 characters)' });
      if (!isSafeUrl(purchaseUrl)) return res.status(400).json({ error: 'purchaseUrl must be a valid http or https URL' });
    }
    if (notes && notes.length > 5000) return res.status(400).json({ error: 'Notes are too long (max 5000 characters)' });
    if (location && location.length > 500) return res.status(400).json({ error: 'Location is too long (max 500 characters)' });
    if (purchaseLocation && purchaseLocation.length > 500) return res.status(400).json({ error: 'Purchase location is too long (max 500 characters)' });

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

    // Verify user has editor/owner access to this cellar. Soft-deleted cellars
    // are rejected too — a bottle added there would be invisible everywhere
    // (all cellar lists filter deletedAt) and effectively lost.
    if (!mongoose.isValidObjectId(cellar)) {
      return res.status(400).json({ error: 'Invalid cellar ID' });
    }
    const cellarDoc = await Cellar.findById(cellar);
    if (!cellarDoc || cellarDoc.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to add bottles to this cellar' });
    }

    // Verify wine definition exists
    if (!mongoose.isValidObjectId(wineDefinition)) {
      return res.status(400).json({ error: 'Invalid wine definition ID' });
    }
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
      vintage: canonicalVintage,
      price,
      currency: currency || 'USD',
      priceSetAt,
      bottleSize: normalizeBottleSize(bottleSize) || DEFAULT_SIZE,
      purchaseDate: purchaseDate || new Date(),
      purchaseLocation: stripHtml(purchaseLocation),
      purchaseUrl,
      location: stripHtml(location),
      notes: stripHtml(notes),
      rating: resolvedRating,
      ratingScale: resolvedRatingScale
    });

    // Allow backdating the "added" date for cellar migration
    if (dateAdded) bottle.createdAt = new Date(dateAdded);

    // Seed the cellar journey: the bottle enters this cellar at its added date.
    bottle.addedToCellarAt = bottle.createdAt;
    bottle.cellarHistory = [{ cellar: cellarDoc._id, cellarName: cellarDoc.name, enteredAt: bottle.createdAt }];

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

    // Index in Meilisearch (fire-and-forget) — skip if added directly as consumed
    if (!addToHistory) searchService.indexBottle(bottle._id);

    // Seed the sommelier maturity queue for this wine+vintage (no-op for
    // "Unknown"; NV is included). Shared by every add/import path.
    await ensurePendingVintageProfile(wineDoc._id, canonicalVintage);

    logAudit(req, addToHistory ? 'bottle.addToHistory' : 'bottle.add',
      { type: 'bottle', id: bottle._id, cellarId: cellarDoc._id },
      { wineName: bottle.wineDefinition?.name, vintage: bottle.vintage }
    );

    // Fire-and-forget: embed this (wine, vintage) pair for AI chat
    embedSinglePair(wineDefinition, bottle.vintage).catch(err => console.error('Failed to embed wine-vintage pair after bottle creation:', err.message));

    // Fire-and-forget: if this wine has no AI tasting profile yet (e.g. a brand-
    // new wine the user just created), generate one — which also re-embeds the
    // wine so Qdrant carries the taste data. No-op if already enriched / a batch
    // enrichment job is running / AI isn't configured.
    enrichWineById(wineDefinition).catch(() => {});

    // Fire-and-forget: auto-resolve any restock alerts for this wine
    resolveRestockAlerts(req.user.id, wineDefinition, bottle._id).catch(() => {});

    // Non-blocking sanity warnings on the entered price. Surfaced in the
    // response so the form can highlight a likely mistake (100×, cents-as-
    // units, etc.) without rejecting the save. See utils/priceValidation.
    let priceWarnings = [];
    if (typeof price === 'number' && price > 0) {
      try {
        priceWarnings = await gatherPriceWarnings({
          price,
          currency: currency || 'USD',
          userId: cellarDoc.user,
          wineDefinitionId: wineDefinition,
          vintage: canonicalVintage,
        });
      } catch (err) {
        console.warn('Price-warning gather failed (non-fatal):', err.message);
      }
    }

    res.status(201).json({ bottle, priceWarnings });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
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
    // it immediately on their bottle — other users see wine?.image after approval.
    // Bottles pending a wine request have no wineDefinition; that branch must be
    // omitted, or `{ wineDefinition: undefined }` matches every document and the
    // lookup returns a pending image from an unrelated bottle.
    const pendingImgOr = [{ bottle: bottle._id }];
    if (bottle.wineDefinition) {
      pendingImgOr.push({ wineDefinition: bottle.wineDefinition });
    }
    const pendingImg = await BottleImage.findOne({
      $or: pendingImgOr,
      uploadedBy: req.user.id,
      status: { $in: ['uploaded', 'processing', 'processed'] }
    }).sort({ createdAt: -1 }).lean();

    const pendingImageUrl = pendingImg
      ? (pendingImg.processedUrl || pendingImg.originalUrl)
      : null;

    // Resolve user's chosen default bottle image to a URL
    let defaultImageUrl = null;
    if (bottle.defaultImage) {
      const defaultImg = await BottleImage.findById(bottle.defaultImage).lean();
      if (defaultImg) {
        defaultImageUrl = defaultImg.processedUrl || defaultImg.originalUrl;
      }
    }

    // Community "current release" price for this wine in the bottle's currency —
    // the replacement-value signal for ordinary bottles. Null when there's no
    // community data in that currency yet. Never converted across currencies.
    let currentRelease = null;
    const wineId = bottle.wineDefinition && (bottle.wineDefinition._id || bottle.wineDefinition);
    if (wineId) {
      currentRelease = await getCurrentRelease(wineId, bottle.currency);
    }

    const ucEntry = cellar.userColors?.find(uc => uc.user.toString() === req.user.id.toString());
    res.json({ bottle: bottleObj, userRole: role, cellarColor: ucEntry?.color || null, pendingImageUrl, defaultImageUrl, currentRelease });
  } catch (error) {
    console.error('Get bottle error:', error);
    res.status(500).json({ error: 'Failed to get bottle' });
  }
});

// PUT /api/bottles/:id - Update bottle (owner or editor)
router.put('/:id', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;

    if (req.body.purchaseUrl) {
      if (req.body.purchaseUrl.length > 2048) return res.status(400).json({ error: 'purchaseUrl is too long (max 2048 characters)' });
      if (!isSafeUrl(req.body.purchaseUrl)) return res.status(400).json({ error: 'purchaseUrl must be a valid http or https URL' });
    }
    if (req.body.notes && req.body.notes.length > 5000) return res.status(400).json({ error: 'Notes are too long (max 5000 characters)' });
    if (req.body.location && req.body.location.length > 500) return res.status(400).json({ error: 'Location is too long (max 500 characters)' });
    if (req.body.purchaseLocation && req.body.purchaseLocation.length > 500) return res.status(400).json({ error: 'Purchase location is too long (max 500 characters)' });

    // Coerce vintage to its canonical form (or reject) before the generic
    // field-diff loop assigns it onto the bottle.
    if ('vintage' in req.body) {
      const vintageCheck = parseAndValidateVintage(req.body.vintage);
      if (!vintageCheck.ok) return res.status(400).json({ error: vintageCheck.error });
      req.body.vintage = vintageCheck.value;
    }

    // Canonicalize bottle size on the way in (e.g. '1.5L (Magnum)' → '1500ml').
    if (req.body.bottleSize !== undefined) {
      req.body.bottleSize = normalizeBottleSize(req.body.bottleSize) || DEFAULT_SIZE;
    }

    // Update allowed fields — diff old vs new for the audit log
    const updateFields = [
      'vintage', 'price', 'currency', 'bottleSize',
      'purchaseDate', 'purchaseLocation', 'purchaseUrl',
      'location', 'notes', 'rating', 'ratingScale'
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

    // Re-index in Meilisearch (fire-and-forget)
    searchService.indexBottle(bottle._id);

    if (Object.keys(changes).length > 0) {
      logAudit(req, 'bottle.update',
        { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
        { changes }
      );
    }

    // If vintage changed, the old (wine, oldVintage) embedding is still in Qdrant
    // but won't match this bottle anymore (user changed the year). Embed the new pair.
    if (changes.vintage) {
      embedSinglePair(bottle.wineDefinition._id || bottle.wineDefinition, bottle.vintage).catch(err => console.error('Failed to embed wine-vintage pair after vintage update:', err.message));
    }

    res.json({ bottle });
  } catch (error) {
    if (error.name === 'VersionError') {
      return res.status(409).json({ error: 'This bottle was modified by another request. Please refresh and try again.' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Update bottle error:', error);
    res.status(500).json({ error: 'Failed to update bottle' });
  }
});

// PUT /api/bottles/:id/consumed-rating - Set or update rating on a consumed bottle
router.put('/:id/consumed-rating', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;
    if (!CONSUMED_STATUSES.includes(bottle.status)) {
      return res.status(400).json({ error: 'Bottle is not consumed' });
    }

    const { rating, ratingScale, note } = req.body;

    if (rating !== undefined) {
      const { rating: resolved, ratingScale: resolvedScale, error: ratingError } = resolveRating(rating, ratingScale);
      if (ratingError) return res.status(400).json({ error: ratingError });
      bottle.consumedRating = resolved;
      bottle.consumedRatingScale = resolvedScale;
    }

    if (note !== undefined) {
      if (note.length > 1000) return res.status(400).json({ error: 'Note is too long (max 1000 characters)' });
      bottle.consumedNote = stripHtml(note);
    }

    await bottle.save();
    await bottle.populate(WINE_POPULATE);

    logAudit(req, 'bottle.update',
      { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
      { changes: { consumedRating: rating, consumedNote: note !== undefined } }
    );

    res.json({ bottle });
  } catch (error) {
    console.error('Update consumed rating error:', error);
    res.status(500).json({ error: 'Failed to update consumed rating' });
  }
});

// PUT /api/bottles/:id/default-image - Set the user's preferred default image for this bottle
router.put('/:id/default-image', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;
    const { imageId } = req.body;

    if (!imageId) {
      // Clear default image
      bottle.defaultImage = null;
      await bottle.save();
      return res.json({ bottle });
    }

    // Verify the image exists and belongs to this bottle or its wine definition
    const image = await BottleImage.findOne({
      _id: imageId,
      $or: [
        { bottle: bottle._id },
        { wineDefinition: bottle.wineDefinition, status: 'approved' }
      ]
    });

    if (!image) {
      return res.status(404).json({ error: 'Image not found or not associated with this bottle' });
    }

    bottle.defaultImage = image._id;
    await bottle.save();
    await bottle.populate(WINE_POPULATE);

    res.json({ bottle });
  } catch (error) {
    console.error('Set default image error:', error);
    res.status(500).json({ error: 'Failed to set default image' });
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

    if (note && (typeof note !== 'string' || note.length > 1000)) {
      return res.status(400).json({ error: 'Note is too long (max 1000 characters)' });
    }

    const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumeRatingError } = resolveRating(rating, consumedRatingScale);
    if (consumeRatingError) return res.status(400).json({ error: consumeRatingError });

    bottle.status = reason;
    bottle.consumedAt = new Date();
    bottle.consumedReason = reason;
    if (note) bottle.consumedNote = stripHtml(note);
    if (resolvedConsumedRating !== undefined) {
      bottle.consumedRating = resolvedConsumedRating;
      bottle.consumedRatingScale = resolvedConsumedScale;
    }

    await bottle.save();

    // Remove from any rack slot so the slot is freed up — after the save, so a
    // failed save doesn't leave an active bottle already pulled from its rack
    await removeFromRacks(bottle._id);

    // Remove from Meilisearch (consumed bottles are excluded)
    searchService.indexBottle(bottle._id);

    logAudit(req, 'bottle.consume',
      { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
      { reason }
    );

    // Fire-and-forget: check if user needs a restock alert (paid plans only)
    if (reason === 'drank') {
      checkRestockGap(req.user.id, bottle._id, bottle.cellar).catch(() => {});
    }

    res.json({ bottle });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Consume bottle error:', error);
    res.status(500).json({ error: 'Failed to consume bottle' });
  }
});

// POST /api/bottles/:id/move - Move an active bottle to another cellar you own.
// v1: own-cellars-only + active bottles only; the bottle lands UNPLACED in the
// destination (freed from any source rack slot). All bottle data is kept —
// createdAt (acquisition date) is preserved; addedToCellarAt + cellarHistory are
// updated. requireBottleAccess('owner') enforces you own the SOURCE cellar.
router.post('/:id/move', requireBottleAccess('owner'), async (req, res) => {
  try {
    const { bottle, cellar: sourceCellar } = req;
    const { toCellarId } = req.body;

    if (!toCellarId || !mongoose.isValidObjectId(toCellarId)) {
      return res.status(400).json({ error: 'Invalid destination cellar' });
    }
    if (String(toCellarId) === String(sourceCellar._id)) {
      return res.status(400).json({ error: 'Bottle is already in that cellar' });
    }
    if (bottle.status !== 'active') {
      return res.status(400).json({ error: 'Only active bottles can be moved' });
    }

    // Destination must be an active cellar the user OWNS (v1: own cellars only).
    // Cast the (already isValidObjectId-checked) id to an ObjectId so the query
    // value can never be a user-supplied operator object (defence-in-depth + keeps
    // static NoSQL-injection analysis happy).
    const destCellar = await Cellar.findOne({
      _id: new mongoose.Types.ObjectId(String(toCellarId)),
      user: req.user.id,
      deletedAt: null,
    });
    if (!destCellar) return res.status(404).json({ error: 'Destination cellar not found' });

    const now = new Date();
    // Backfill the origin entry for bottles created before cellarHistory existed
    // (or imported), so the journey reads "added → moved", not just "moved".
    if (bottle.cellarHistory.length === 0) {
      bottle.cellarHistory.push({
        cellar: sourceCellar._id, cellarName: sourceCellar.name,
        enteredAt: bottle.addedToCellarAt || bottle.createdAt
      });
    }
    bottle.cellar = destCellar._id;
    bottle.addedToCellarAt = now;
    bottle.cellarHistory.push({ cellar: destCellar._id, cellarName: destCellar.name, enteredAt: now });
    // Commit the move FIRST — if it hits an optimistic-concurrency conflict the
    // source rack is still untouched, so we never orphan a slot.
    await bottle.save();

    // Now free the bottle from its old rack slot — it arrives unplaced. A failure
    // here would only leave a stale slot that self-heals on the next rack render,
    // never a bottle knocked out of its rack while still in the old cellar.
    await removeFromRacks(bottle._id);

    // Re-index so search reflects the new cellar.
    searchService.indexBottle(bottle._id);
    await bottle.populate(WINE_POPULATE);

    // Audit BOTH cellars so the move is followable from either side's audit log.
    const wineName = bottle.wineDefinition?.name;
    logAudit(req, 'bottle.move.out',
      { type: 'bottle', id: bottle._id, cellarId: sourceCellar._id },
      { toCellarId: destCellar._id, toCellarName: destCellar.name, wineName, vintage: bottle.vintage }
    );
    logAudit(req, 'bottle.move.in',
      { type: 'bottle', id: bottle._id, cellarId: destCellar._id },
      { fromCellarId: sourceCellar._id, fromCellarName: sourceCellar.name, wineName, vintage: bottle.vintage }
    );

    res.json({ bottle });
  } catch (error) {
    if (error.name === 'VersionError') {
      return res.status(409).json({ error: 'This bottle was modified by another request. Please refresh and try again.' });
    }
    console.error('Move bottle error:', error);
    res.status(500).json({ error: 'Failed to move bottle' });
  }
});

// POST /api/bottles/:id/undo - Reverse an incorrectly-added bottle.
// The bottle disappears from cellar, racks, search, and stats as if it had
// never been added. Internal audit log keeps the original `bottle.add` row
// plus a new `bottle.undo` row so admins can still investigate disputes.
// Active bottles only — consumed bottles must use a different path.
router.post('/:id/undo', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;

    if (bottle.status !== 'active') {
      return res.status(400).json({
        error: 'Only active bottles can be marked as a mistake. Already-consumed bottles cannot be undone.'
      });
    }

    const bottleId = bottle._id;
    const cellarId = bottle.cellar;
    const pendingRequestId = bottle.pendingWineRequest || null;

    await removeFromRacks(bottleId);
    searchService.removeBottle(bottleId);

    // Bottle-only images go away. Images promoted to a WineDefinition (e.g.
    // approved community photos) stay, but lose their link back to this bottle.
    await BottleImage.deleteMany({ bottle: bottleId, assignedToWine: false });
    await BottleImage.updateMany(
      { bottle: bottleId, assignedToWine: true },
      { $set: { bottle: null } }
    );

    // If this bottle held a still-pending wine request, drop it — the user
    // is saying the entry shouldn't have been created in the first place.
    // Resolved/rejected requests are admin-actioned and stay put.
    if (pendingRequestId) {
      await WineRequest.deleteOne({ _id: pendingRequestId, status: 'pending' });
    }

    await bottle.deleteOne();

    logAudit(req, 'bottle.undo',
      { type: 'bottle', id: bottleId, cellarId },
      { reason: 'mistake' }
    );

    res.json({ message: 'Bottle removed as mistake' });
  } catch (error) {
    console.error('Undo bottle error:', error);
    res.status(500).json({ error: 'Failed to undo bottle' });
  }
});

// DELETE /api/bottles/:id - Delete bottle (owner or editor)
router.delete('/:id', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;

    // Remove bottle from any rack slot that references it
    await removeFromRacks(bottle._id);

    // Remove from Meilisearch before deleting
    searchService.removeBottle(bottle._id);

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
