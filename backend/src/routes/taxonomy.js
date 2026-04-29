/**
 * Public taxonomy routes — no auth required.
 * Powers the public /regions/:slug, /countries/:slug, /grapes/:slug,
 * and /wines/type/:type discovery pages.
 *
 * All endpoints are rate-limited and return paginated wine lists
 * with the minimum data needed for the public page (no personal info).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const WineDefinition = require('../models/WineDefinition');
const { parsePagination } = require('../utils/pagination');

const router = express.Router();

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MIN_WINES = 3; // gate: don't render pages with fewer wines

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
router.use(limiter);

// Shared wine projection for public lists
const WINE_PROJECTION = 'name producer slug type appellation region country image communityRating';

// ── Countries ────────────────────────────────────────────────────────────────

// GET /api/taxonomy/countries — list all countries that have ≥MIN_WINES wines
router.get('/countries', async (req, res) => {
  try {
    const countries = await Country.find({ slug: { $exists: true, $ne: null } })
      .select('name slug code description')
      .sort({ name: 1 })
      .lean();

    const result = [];
    for (const c of countries) {
      const count = await WineDefinition.countDocuments({ country: c._id });
      if (count >= MIN_WINES) result.push({ ...c, wineCount: count });
    }

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ countries: result, total: result.length });
  } catch (err) {
    console.error('[taxonomy] countries list error:', err);
    res.status(500).json({ error: 'Failed to fetch countries' });
  }
});

// GET /api/taxonomy/countries/:slug
router.get('/countries/:slug', async (req, res) => {
  try {
    const country = await Country.findOne({ slug: String(req.params.slug).toLowerCase() })
      .select('name slug code description')
      .lean();
    if (!country) return res.status(404).json({ error: 'Country not found' });

    const { limit, offset } = parsePagination(req.query, { limit: 24, maxLimit: 100 });

    const [wines, total, regions] = await Promise.all([
      WineDefinition.find({ country: country._id })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ country: country._id }),
      Region.find({ country: country._id, slug: { $exists: true } })
        .select('name slug description')
        .sort({ name: 1 })
        .lean()
    ]);

    if (total < MIN_WINES) return res.status(404).json({ error: 'Country not found' });

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ country, regions, wines, total, offset, limit });
  } catch (err) {
    console.error('[taxonomy] country detail error:', err);
    res.status(500).json({ error: 'Failed to fetch country' });
  }
});

// ── Regions ──────────────────────────────────────────────────────────────────

// GET /api/taxonomy/regions — list all regions with ≥MIN_WINES wines
router.get('/regions', async (req, res) => {
  try {
    const regions = await Region.find({ slug: { $exists: true, $ne: null } })
      .select('name slug description country')
      .populate('country', 'name slug')
      .sort({ name: 1 })
      .lean();

    const result = [];
    for (const r of regions) {
      const count = await WineDefinition.countDocuments({ region: r._id });
      if (count >= MIN_WINES) result.push({ ...r, wineCount: count });
    }

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ regions: result, total: result.length });
  } catch (err) {
    console.error('[taxonomy] regions list error:', err);
    res.status(500).json({ error: 'Failed to fetch regions' });
  }
});

// GET /api/taxonomy/regions/:slug
router.get('/regions/:slug', async (req, res) => {
  try {
    const region = await Region.findOne({ slug: String(req.params.slug).toLowerCase() })
      .select('name slug description classification styles typicalGrapes permittedGrapes country')
      .populate('country', 'name slug')
      .populate('typicalGrapes', 'name slug color')
      .lean();
    if (!region) return res.status(404).json({ error: 'Region not found' });

    const { limit, offset } = parsePagination(req.query, { limit: 24, maxLimit: 100 });

    const [wines, total] = await Promise.all([
      WineDefinition.find({ region: region._id })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .populate('grapes', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ region: region._id })
    ]);

    if (total < MIN_WINES) return res.status(404).json({ error: 'Region not found' });

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ region, wines, total, offset, limit });
  } catch (err) {
    console.error('[taxonomy] region detail error:', err);
    res.status(500).json({ error: 'Failed to fetch region' });
  }
});

// ── Grapes ───────────────────────────────────────────────────────────────────

// GET /api/taxonomy/grapes — list all grapes with ≥MIN_WINES wines
router.get('/grapes', async (req, res) => {
  try {
    const grapes = await Grape.find({ slug: { $exists: true, $ne: null } })
      .select('name slug color description')
      .sort({ name: 1 })
      .lean();

    const result = [];
    for (const g of grapes) {
      const count = await WineDefinition.countDocuments({ grapes: g._id });
      if (count >= MIN_WINES) result.push({ ...g, wineCount: count });
    }

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ grapes: result, total: result.length });
  } catch (err) {
    console.error('[taxonomy] grapes list error:', err);
    res.status(500).json({ error: 'Failed to fetch grapes' });
  }
});

// GET /api/taxonomy/grapes/:slug
router.get('/grapes/:slug', async (req, res) => {
  try {
    const grape = await Grape.findOne({ slug: String(req.params.slug).toLowerCase() })
      .select('name slug color origin characteristics agingPotential synonyms description')
      .lean();
    if (!grape) return res.status(404).json({ error: 'Grape not found' });

    const { limit, offset } = parsePagination(req.query, { limit: 24, maxLimit: 100 });

    const [wines, total] = await Promise.all([
      WineDefinition.find({ grapes: grape._id })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ grapes: grape._id })
    ]);

    if (total < MIN_WINES) return res.status(404).json({ error: 'Grape not found' });

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ grape, wines, total, offset, limit });
  } catch (err) {
    console.error('[taxonomy] grape detail error:', err);
    res.status(500).json({ error: 'Failed to fetch grape' });
  }
});

// ── Wine types ────────────────────────────────────────────────────────────────

// GET /api/taxonomy/wine-types/:type
router.get('/wine-types/:type', async (req, res) => {
  try {
    const type = String(req.params.type).toLowerCase();
    if (!WINE_TYPES.includes(type)) return res.status(404).json({ error: 'Unknown wine type' });

    const { limit, offset } = parsePagination(req.query, { limit: 24, maxLimit: 100 });

    const [wines, total] = await Promise.all([
      WineDefinition.find({ type })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ type })
    ]);

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ type, wines, total, offset, limit });
  } catch (err) {
    console.error('[taxonomy] wine-type error:', err);
    res.status(500).json({ error: 'Failed to fetch wines by type' });
  }
});

module.exports = router;
