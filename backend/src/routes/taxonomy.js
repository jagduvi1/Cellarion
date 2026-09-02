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
const { baseLanguage, localizedName } = require('../utils/localizedName');
const { rateLimitKey } = require('../utils/clientIp');

const router = express.Router();

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MIN_WINES = 3; // gate: don't render pages with fewer wines

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Key on the real client, as every other per-IP limiter does. Without it
  // the key was req.ip — the Cloudflare edge on the hosted instance — so every
  // visitor arriving through the same edge shared ONE 60-request bucket, and
  // this router also serves /display-names, which the logged-in app loads
  // (audit 2026-09-02, phase 1).
  keyGenerator: rateLimitKey,
});
router.use(limiter);

// Server-side cache for the list endpoints. They aggregate wine counts over
// the whole registry and only change on admin taxonomy/wine edits; clients
// already get Cache-Control max-age=3600, this stops each cold client from
// re-running the aggregation.
const listCache = new Map(); // key -> { at, body }
const LIST_CACHE_TTL_MS = 10 * 60 * 1000;

function getCachedList(key) {
  const entry = listCache.get(key);
  return entry && Date.now() - entry.at < LIST_CACHE_TTL_MS ? entry.body : null;
}

/** Count wines per value of `field` in one aggregation (vs one countDocuments per taxon). */
async function countWinesBy(field, { unwind = false } = {}) {
  const pipeline = unwind
    ? [
        { $match: { nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
        // $setUnion dedups the array first: the old countDocuments({grapes: id})
        // counted a wine once however many times the grape appeared in its
        // array; a bare $unwind would count every occurrence.
        { $project: { values: { $setUnion: [`$${field}`, []] } } },
        { $unwind: '$values' },
        { $group: { _id: '$values', count: { $sum: 1 } } },
      ]
    : [
        { $match: { [field]: { $ne: null }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      ];
  const rows = await WineDefinition.aggregate(pipeline);
  return new Map(rows.map(r => [String(r._id), r.count]));
}

/**
 * Drop the cached list bodies. Called by the admin taxonomy routes after any
 * mutation so renames/deletions don't keep serving on the public lists for
 * the full cache TTL.
 */
function clearTaxonomyListCache() {
  listCache.clear();
}

// Shared wine projection for public lists
const WINE_PROJECTION = 'name producer slug type appellation region country image communityRating';

// ── Display names ────────────────────────────────────────────────────────────

/**
 * GET /api/taxonomy/display-names?lang=fr
 *
 * Every country and region that HAS a name in this language, as two lookup
 * maps. Deliberately not folded into the existing endpoints: taxonomy names
 * are rendered in ~30 places across the app, most of which never call a
 * taxonomy route at all — they receive a populated `region` on a wine or a
 * bottle. Serving one small map the client resolves against localises all of
 * them at once, and leaves every query, projection and cache in the codebase
 * untouched. A surface nobody has adopted keeps showing English, which is
 * exactly what it shows today.
 *
 * Keyed twice on purpose. `byId` is exact and is what a populated taxonomy
 * object resolves through; `byName` catches the denormalised places that hold
 * only the canonical string. Region names can in principle repeat across
 * countries, so byName is a display convenience — byId is the authority.
 *
 * Only translated entries are included, so an untranslated language returns
 * empty maps and costs the client nothing.
 */
router.get('/display-names', async (req, res) => {
  try {
    const lang = baseLanguage(req.query.lang);
    // English IS the canonical name — there is nothing to override, and
    // answering with an empty body keeps the client's code path identical.
    if (!lang || lang === 'en') {
      res.set('Cache-Control', 'public, max-age=3600');
      return res.json({ lang: lang || null, byId: {}, byName: {}, total: 0 });
    }

    const cacheKey = `display-names:${lang}`;
    const cached = getCachedList(cacheKey);
    res.set('Cache-Control', 'public, max-age=3600');
    if (cached) return res.json(cached);

    // The whole map, not a `translations.${lang}` projection: how a dotted Map
    // path reshapes under .lean() is a detail worth not depending on, and the
    // maps hold one short string per shipped language. The FILTER is dotted
    // (queries on Map paths are well defined) so only translated docs are read.
    const field = `translations.${lang}`;
    const [countries, regions] = await Promise.all([
      Country.find({ [field]: { $exists: true, $ne: '' } }).select('name translations').lean(),
      Region.find({ [field]: { $exists: true, $ne: '' } }).select('name translations').lean(),
    ]);

    const byId = {};
    const byName = {};
    for (const doc of [...countries, ...regions]) {
      const value = localizedName(doc, lang);
      // localizedName falls back to the canonical name, so an equal value means
      // "not actually translated" and has no business in an override map.
      if (!value || value === doc.name) continue;
      byId[String(doc._id)] = value;
      if (doc.name) byName[doc.name] = value;
    }

    const body = { lang, byId, byName, total: Object.keys(byId).length };
    listCache.set(cacheKey, { at: Date.now(), body });
    res.json(body);
  } catch (err) {
    console.error('[taxonomy] display-names error:', err);
    res.status(500).json({ error: 'Failed to fetch display names' });
  }
});

// ── Countries ────────────────────────────────────────────────────────────────

// GET /api/taxonomy/countries — list all countries that have ≥MIN_WINES wines
router.get('/countries', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    const cached = getCachedList('countries');
    if (cached) return res.json(cached);

    const [countries, countByCountry] = await Promise.all([
      Country.find({ slug: { $exists: true, $ne: null } })
        .select('name slug code description')
        .sort({ name: 1 })
        .lean(),
      countWinesBy('country'),
    ]);

    const result = [];
    for (const c of countries) {
      const count = countByCountry.get(String(c._id)) || 0;
      if (count >= MIN_WINES) result.push({ ...c, wineCount: count });
    }

    const body = { countries: result, total: result.length };
    listCache.set('countries', { at: Date.now(), body });
    res.json(body);
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
      WineDefinition.find({ country: country._id, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ country: country._id, nonWine: { $ne: true }, pendingIdentity: { $ne: true } }),
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
    res.set('Cache-Control', 'public, max-age=3600');
    const cached = getCachedList('regions');
    if (cached) return res.json(cached);

    const [regions, countByRegion] = await Promise.all([
      Region.find({ slug: { $exists: true, $ne: null } })
        .select('name slug description country')
        .populate('country', 'name slug')
        .sort({ name: 1 })
        .lean(),
      countWinesBy('region'),
    ]);

    const result = [];
    for (const r of regions) {
      const count = countByRegion.get(String(r._id)) || 0;
      if (count >= MIN_WINES) result.push({ ...r, wineCount: count });
    }

    const body = { regions: result, total: result.length };
    listCache.set('regions', { at: Date.now(), body });
    res.json(body);
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
      WineDefinition.find({ region: region._id, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .populate('grapes', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ region: region._id, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
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
    res.set('Cache-Control', 'public, max-age=3600');
    const cached = getCachedList('grapes');
    if (cached) return res.json(cached);

    const [grapes, countByGrape] = await Promise.all([
      Grape.find({ slug: { $exists: true, $ne: null } })
        .select('name slug color description')
        .sort({ name: 1 })
        .lean(),
      countWinesBy('grapes', { unwind: true }),
    ]);

    const result = [];
    for (const g of grapes) {
      const count = countByGrape.get(String(g._id)) || 0;
      if (count >= MIN_WINES) result.push({ ...g, wineCount: count });
    }

    const body = { grapes: result, total: result.length };
    listCache.set('grapes', { at: Date.now(), body });
    res.json(body);
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
      WineDefinition.find({ grapes: grape._id, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ grapes: grape._id, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
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
      WineDefinition.find({ type, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
        .select(WINE_PROJECTION)
        .populate('region', 'name slug')
        .populate('country', 'name slug')
        .sort({ name: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      WineDefinition.countDocuments({ type, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
    ]);

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ type, wines, total, offset, limit });
  } catch (err) {
    console.error('[taxonomy] wine-type error:', err);
    res.status(500).json({ error: 'Failed to fetch wines by type' });
  }
});

module.exports = router;
module.exports.clearTaxonomyListCache = clearTaxonomyListCache;
// Shared with sitemap.js — one aggregation instead of one countDocuments per taxon.
module.exports.countWinesBy = countWinesBy;
