const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { normalizeString, normalizeAppellation, normalizeAppellationKey } = require('../../utils/normalize');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Grape = require('../../models/Grape');
const Appellation = require('../../models/Appellation');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { distinctSizes, normalizeAll, remap } = require('../../services/bottleSizeMaintenance');
const { mergeGrapes, mergeRegions, mergeCountries } = require('../../services/taxonomyMerge');
const { BOTTLE_SIZES } = require('../../config/bottleSizes');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// Public taxonomy lists are served from a 10-minute server-side cache —
// drop it after any successful admin mutation so renames/deletions show up
// immediately instead of after the TTL.
const { clearTaxonomyListCache } = require('../taxonomy');

// ── Usage counts for the admin lists ─────────────────────────────────────────
// The taxonomy UI gained merge/delete power (strategy 2026-07-29 R5), and both
// verbs need the same context to be used safely: how many wines actually
// reference this doc. Delete already refuses non-zero usage server-side; the
// count makes that visible BEFORE the click, and for merges it tells the admin
// which of two spellings is the real one (merge the 1-wine typo into the
// 300-wine canonical, never the reverse).

/** Map<idString, wineCount> for a ref field ('country' | 'region'). */
async function wineCountsByRef(field) {
  const rows = await WineDefinition.aggregate([
    { $match: { [field]: { $ne: null } } },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n]));
}

/** Map<grapeIdString, wineCount> (grapes is an array field). */
async function wineCountsByGrape() {
  const rows = await WineDefinition.aggregate([
    { $unwind: '$grapes' },
    { $group: { _id: '$grapes', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n]));
}

/**
 * Map<normalizedAppellation, wineCount>. Wines store the appellation as free
 * text (not a ref — see routes/admin/import.js), so the join is by normalized
 * string: the same normalization both writers apply.
 */
async function wineCountsByAppellation() {
  const rows = await WineDefinition.aggregate([
    { $match: { appellation: { $nin: [null, ''] } } },
    { $group: { _id: '$appellation', n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) {
    const key = normalizeAppellationKey(normalizeAppellation(r._id || '') || r._id || '');
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + r.n);
  }
  return map;
}
router.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) clearTaxonomyListCache();
    });
  }
  next();
});

// ===== COUNTRIES =====

// GET /api/admin/taxonomy/countries - List all countries
router.get('/countries', async (req, res) => {
  try {
    const [countries, wineCounts, regionAgg] = await Promise.all([
      Country.find().sort({ name: 1 }).lean(),
      wineCountsByRef('country'),
      Region.aggregate([{ $group: { _id: '$country', n: { $sum: 1 } } }]),
    ]);
    const regionCounts = new Map(regionAgg.map(r => [String(r._id), r.n]));
    const rows = countries.map(c => ({
      ...c,
      wineCount: wineCounts.get(String(c._id)) || 0,
      regionCount: regionCounts.get(String(c._id)) || 0,
    }));
    res.json({ count: rows.length, countries: rows });
  } catch (error) {
    console.error('Get countries error:', error);
    res.status(500).json({ error: 'Failed to get countries' });
  }
});

// POST /api/admin/taxonomy/countries - Add country
router.post('/countries', async (req, res) => {
  try {
    const { name, code, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Country name is required' });
    }

    const normalizedName = normalizeString(name);

    const country = new Country({
      name: name.trim(),
      code: code?.trim().toUpperCase(),
      normalizedName,
      description: description || '',
      createdBy: req.user.id
    });

    await country.save();
    logAudit(req, 'admin.taxonomy.create',
      { type: 'country', id: country._id },
      { name: country.name }
    );
    res.status(201).json({ country });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Country already exists' });
    }
    console.error('Create country error:', error);
    res.status(500).json({ error: 'Failed to create country' });
  }
});

// PUT /api/admin/taxonomy/countries/:id - Update country
router.put('/countries/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { name, code, description } = req.body;

    const country = await Country.findById(req.params.id);
    if (!country) {
      return res.status(404).json({ error: 'Country not found' });
    }

    if (name) {
      country.name = name.trim();
      country.normalizedName = normalizeString(name);
    }
    if (code !== undefined) {
      country.code = code?.trim().toUpperCase();
    }
    if (description !== undefined) country.description = description;

    await country.save();
    logAudit(req, 'admin.taxonomy.update',
      { type: 'country', id: country._id },
      { name: country.name }
    );

    // Resync search indexes if name changed (denormalized data). Bottle
    // documents denormalize taxonomy names too — fullSync() alone rebuilds
    // only the wines index, leaving cellar search matching the old name.
    if (name) { searchService.fullSync(); searchService.fullSyncBottles(); }

    res.json({ country });
  } catch (error) {
    console.error('Update country error:', error);
    res.status(500).json({ error: 'Failed to update country' });
  }
});

// DELETE /api/admin/taxonomy/countries/:id - Delete country
router.delete('/countries/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const country = await Country.findById(req.params.id);
    if (!country) {
      return res.status(404).json({ error: 'Country not found' });
    }

    // Check if any regions reference this country
    const regionCount = await Region.countDocuments({ country: req.params.id });
    if (regionCount > 0) {
      return res.status(400).json({
        error: `Cannot delete country. ${regionCount} region(s) reference it.`
      });
    }

    // Check if any wines reference this country
    const wineCount = await WineDefinition.countDocuments({ country: req.params.id });
    if (wineCount > 0) {
      return res.status(400).json({
        error: `Cannot delete country. ${wineCount} wine(s) reference it.`
      });
    }

    logAudit(req, 'admin.taxonomy.delete',
      { type: 'country', id: country._id },
      { name: country.name }
    );
    await country.deleteOne();
    res.json({ message: 'Country deleted successfully' });
  } catch (error) {
    console.error('Delete country error:', error);
    res.status(500).json({ error: 'Failed to delete country' });
  }
});

// ===== REGIONS =====

// GET /api/admin/taxonomy/regions - List regions (optionally filter by country)
router.get('/regions', async (req, res) => {
  try {
    const { country } = req.query;
    const filter = {};
    if (country) {
      if (!mongoose.Types.ObjectId.isValid(country)) {
        return res.status(400).json({ error: 'Invalid country id' });
      }
      filter.country = country;
    }

    const [regions, wineCounts] = await Promise.all([
      Region.find(filter)
        .populate('country', 'name')
        .populate('parentRegion', 'name')
        .populate('typicalGrapes', 'name')
        .populate('permittedGrapes', 'name')
        .sort({ name: 1 })
        .lean(),
      wineCountsByRef('region'),
    ]);
    const rows = regions.map(r => ({ ...r, wineCount: wineCounts.get(String(r._id)) || 0 }));

    res.json({ count: rows.length, regions: rows });
  } catch (error) {
    console.error('Get regions error:', error);
    res.status(500).json({ error: 'Failed to get regions' });
  }
});

// POST /api/admin/taxonomy/regions - Add region
router.post('/regions', async (req, res) => {
  try {
    const { name, country, parentRegion, classification, styles,
            agingRules, prestigeLevel, typicalGrapes, permittedGrapes, description } = req.body;

    if (!name || !country) {
      return res.status(400).json({ error: 'Name and country are required' });
    }

    const normalizedName = normalizeString(name);

    // Build hierarchy
    const hierarchy = [];
    if (parentRegion) {
      const parent = await Region.findById(parentRegion);
      if (parent) {
        hierarchy.push(...parent.hierarchy);
      }
    }
    hierarchy.push(name);

    const region = new Region({
      name: name.trim(),
      normalizedName,
      country,
      parentRegion: parentRegion || null,
      hierarchy,
      classification: classification || null,
      styles: styles || [],
      agingRules: agingRules || {},
      prestigeLevel: prestigeLevel || null,
      typicalGrapes: typicalGrapes || [],
      permittedGrapes: permittedGrapes || [],
      description: description || '',
      createdBy: req.user.id
    });

    await region.save();
    await region.populate('country', 'name');
    await region.populate('typicalGrapes', 'name');
    await region.populate('permittedGrapes', 'name');
    logAudit(req, 'admin.taxonomy.create',
      { type: 'region', id: region._id },
      { name: region.name }
    );
    res.status(201).json({ region });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Region already exists in this country' });
    }
    console.error('Create region error:', error);
    res.status(500).json({ error: 'Failed to create region' });
  }
});

// PUT /api/admin/taxonomy/regions/:id - Update region
router.put('/regions/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { name, parentRegion, classification, styles, synonyms,
            agingRules, prestigeLevel, typicalGrapes, permittedGrapes, description } = req.body;

    const region = await Region.findById(req.params.id);
    if (!region) {
      return res.status(404).json({ error: 'Region not found' });
    }

    if (name) {
      region.name = name.trim();
      region.normalizedName = normalizeString(name);
    }

    if (parentRegion) {
      if (!isValidId(parentRegion)) {
        return res.status(400).json({ error: 'Invalid parentRegion' });
      }
      region.parentRegion = parentRegion;
    } else if (parentRegion !== undefined) {
      region.parentRegion = null;
    }

    // Rebuild hierarchy when the name OR parent changed — its last element is
    // this region's own name, so a rename-only update must refresh it too.
    if (name || parentRegion !== undefined) {
      const hierarchy = [];
      if (region.parentRegion) {
        const parent = await Region.findById(region.parentRegion);
        if (parent) {
          hierarchy.push(...parent.hierarchy);
        }
      }
      hierarchy.push(region.name);
      region.hierarchy = hierarchy;
    }

    if (classification !== undefined) region.classification = classification;
    if (synonyms !== undefined) region.synonyms = synonyms;
    if (styles !== undefined) region.styles = styles;
    if (agingRules !== undefined) region.agingRules = agingRules;
    if (prestigeLevel !== undefined) region.prestigeLevel = prestigeLevel;
    if (typicalGrapes !== undefined) region.typicalGrapes = typicalGrapes;
    if (permittedGrapes !== undefined) region.permittedGrapes = permittedGrapes;
    if (description !== undefined) region.description = description;

    await region.save();
    await region.populate('country', 'name');
    await region.populate('typicalGrapes', 'name');
    await region.populate('permittedGrapes', 'name');
    logAudit(req, 'admin.taxonomy.update',
      { type: 'region', id: region._id },
      { name: region.name }
    );

    // Resync search indexes if name changed (denormalized data). Bottle
    // documents denormalize taxonomy names too — fullSync() alone rebuilds
    // only the wines index, leaving cellar search matching the old name.
    if (name) { searchService.fullSync(); searchService.fullSyncBottles(); }

    res.json({ region });
  } catch (error) {
    console.error('Update region error:', error);
    res.status(500).json({ error: 'Failed to update region' });
  }
});

// DELETE /api/admin/taxonomy/regions/:id - Delete region
router.delete('/regions/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const region = await Region.findById(req.params.id);
    if (!region) {
      return res.status(404).json({ error: 'Region not found' });
    }

    // Check if any wines reference this region
    const wineCount = await WineDefinition.countDocuments({ region: req.params.id });
    if (wineCount > 0) {
      return res.status(400).json({
        error: `Cannot delete region. ${wineCount} wine(s) reference it.`
      });
    }

    // Check if any regions have this region as their parent
    const childCount = await Region.countDocuments({ parentRegion: req.params.id });
    if (childCount > 0) {
      return res.status(400).json({
        error: `Cannot delete region. ${childCount} region(s) reference it as parent.`
      });
    }

    logAudit(req, 'admin.taxonomy.delete',
      { type: 'region', id: region._id },
      { name: region.name }
    );
    await region.deleteOne();
    res.json({ message: 'Region deleted successfully' });
  } catch (error) {
    console.error('Delete region error:', error);
    res.status(500).json({ error: 'Failed to delete region' });
  }
});

// ===== GRAPES =====

// GET /api/admin/taxonomy/grapes - List all grapes
router.get('/grapes', async (req, res) => {
  try {
    const [grapes, wineCounts] = await Promise.all([
      Grape.find().sort({ name: 1 }).lean(),
      wineCountsByGrape(),
    ]);
    const rows = grapes.map(g => ({ ...g, wineCount: wineCounts.get(String(g._id)) || 0 }));
    res.json({ count: rows.length, grapes: rows });
  } catch (error) {
    console.error('Get grapes error:', error);
    res.status(500).json({ error: 'Failed to get grapes' });
  }
});

// POST /api/admin/taxonomy/grapes - Add grape
router.post('/grapes', async (req, res) => {
  try {
    const { name, synonyms, color, origin, characteristics, agingPotential, prestige, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Grape name is required' });
    }

    const normalizedName = normalizeString(name);

    const grape = new Grape({
      name: name.trim(),
      normalizedName,
      synonyms: synonyms || [],
      color: color || null,
      origin: origin || null,
      characteristics: characteristics || [],
      agingPotential: agingPotential || null,
      prestige: prestige || null,
      description: description || '',
      createdBy: req.user.id
    });

    await grape.save();
    logAudit(req, 'admin.taxonomy.create',
      { type: 'grape', id: grape._id },
      { name: grape.name }
    );
    res.status(201).json({ grape });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Grape already exists' });
    }
    console.error('Create grape error:', error);
    res.status(500).json({ error: 'Failed to create grape' });
  }
});

// PUT /api/admin/taxonomy/grapes/:id - Update grape
router.put('/grapes/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { name, synonyms, color, origin, characteristics, agingPotential, prestige, description } = req.body;

    const grape = await Grape.findById(req.params.id);
    if (!grape) {
      return res.status(404).json({ error: 'Grape not found' });
    }

    if (name) {
      grape.name = name.trim();
      grape.normalizedName = normalizeString(name);
    }
    if (synonyms !== undefined) grape.synonyms = synonyms;
    if (color !== undefined) grape.color = color;
    if (origin !== undefined) grape.origin = origin;
    if (characteristics !== undefined) grape.characteristics = characteristics;
    if (agingPotential !== undefined) grape.agingPotential = agingPotential;
    if (prestige !== undefined) grape.prestige = prestige;
    if (description !== undefined) grape.description = description;

    await grape.save();
    logAudit(req, 'admin.taxonomy.update',
      { type: 'grape', id: grape._id },
      { name: grape.name }
    );

    // Resync search indexes if name changed (denormalized data). Bottle
    // documents denormalize taxonomy names too — fullSync() alone rebuilds
    // only the wines index, leaving cellar search matching the old name.
    if (name) { searchService.fullSync(); searchService.fullSyncBottles(); }

    res.json({ grape });
  } catch (error) {
    console.error('Update grape error:', error);
    res.status(500).json({ error: 'Failed to update grape' });
  }
});

// DELETE /api/admin/taxonomy/grapes/:id - Delete grape
router.delete('/grapes/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const grape = await Grape.findById(req.params.id);
    if (!grape) {
      return res.status(404).json({ error: 'Grape not found' });
    }

    // Check if any wines reference this grape
    const wineCount = await WineDefinition.countDocuments({ grapes: req.params.id });
    if (wineCount > 0) {
      return res.status(400).json({
        error: `Cannot delete grape. ${wineCount} wine(s) reference it.`
      });
    }

    // Check if any regions list this grape as typical or permitted
    const regionCount = await Region.countDocuments({
      $or: [{ typicalGrapes: req.params.id }, { permittedGrapes: req.params.id }]
    });
    if (regionCount > 0) {
      return res.status(400).json({
        error: `Cannot delete grape. ${regionCount} region(s) reference it.`
      });
    }

    logAudit(req, 'admin.taxonomy.delete',
      { type: 'grape', id: grape._id },
      { name: grape.name }
    );
    await grape.deleteOne();
    res.json({ message: 'Grape deleted successfully' });
  } catch (error) {
    console.error('Delete grape error:', error);
    res.status(500).json({ error: 'Failed to delete grape' });
  }
});

// ===== MERGES =====
// Collapse a duplicate taxonomy doc into its canonical counterpart. All
// references (wines, regions, appellations) are rewritten before the
// duplicate is deleted; for grapes/regions the old name becomes a synonym on
// the canonical doc so label scan / import can't re-mint the duplicate.

const MERGERS = {
  grapes: { fn: mergeGrapes, type: 'grape' },
  regions: { fn: mergeRegions, type: 'region' },
  countries: { fn: mergeCountries, type: 'country' },
};

for (const [path, { fn, type }] of Object.entries(MERGERS)) {
  // POST /api/admin/taxonomy/{grapes|regions|countries}/merge - Body: { fromId, toId }
  router.post(`/${path}/merge`, async (req, res) => {
    try {
      const { fromId, toId } = req.body || {};
      if (!isValidId(fromId) || !isValidId(toId)) {
        return res.status(400).json({ error: 'fromId and toId must be valid ids' });
      }
      const summary = await fn(fromId, toId);
      logAudit(req, 'admin.taxonomy.merge',
        { type, id: toId },
        { from: fromId, ...summary }
      );
      // Affected wines are reindexed by the service; bottle documents
      // denormalize taxonomy names too, so rebuild the bottles index.
      searchService.fullSyncBottles();
      res.json({ merged: true, ...summary });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error(`Merge ${type} error:`, error);
      res.status(500).json({ error: `Failed to merge ${type}` });
    }
  });
}

// ===== APPELLATIONS =====

// GET /api/admin/taxonomy/appellations/unmatched — the appellation review
// queue (strategy 2026-07-29 R2). Wines store appellations as free text; this
// lists every distinct normalized string that NO curated Appellation doc (by
// name or synonym) covers, with the majority display spelling and the
// majority country/region so the admin can promote it in one click (the
// existing create endpoint) or fix the wines. Unknown values are reviewed,
// never rejected — adding a bottle must not be blocked by taxonomy.
router.get('/appellations/unmatched', async (req, res) => {
  try {
    const [existing, rows] = await Promise.all([
      Appellation.find({}).select('normalizedName normalizedSynonyms').lean(),
      WineDefinition.aggregate([
        { $match: { appellation: { $nin: [null, ''] }, nonWine: { $ne: true } } },
        { $group: { _id: { ap: '$appellation', country: '$country', region: '$region' }, n: { $sum: 1 } } },
      ]),
    ]);
    const matched = new Set();
    for (const a of existing) {
      if (a.normalizedName) matched.add(a.normalizedName);
      for (const s of a.normalizedSynonyms || []) matched.add(s);
    }

    // normalized → aggregate across raw-spelling/country/region variants
    const groups = new Map();
    for (const r of rows) {
      // Tier-strip before grouping, mirroring the seed script: pre-guard rows
      // ("… DO", "… DOCG") fold into their clean form instead of listing twice.
      const cleaned = normalizeAppellation(r._id.ap || '') || r._id.ap || '';
      const key = normalizeAppellationKey(cleaned);
      if (!key || matched.has(key)) continue;
      let g = groups.get(key);
      if (!g) { g = { spellings: new Map(), countries: new Map(), regions: new Map(), total: 0 }; groups.set(key, g); }
      g.total += r.n;
      g.spellings.set(cleaned, (g.spellings.get(cleaned) || 0) + r.n);
      if (r._id.country) g.countries.set(String(r._id.country), (g.countries.get(String(r._id.country)) || 0) + r.n);
      if (r._id.region) g.regions.set(String(r._id.region), (g.regions.get(String(r._id.region)) || 0) + r.n);
    }

    const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const countryIds = new Set(), regionIds = new Set();
    const items = [...groups.entries()].map(([normalized, g]) => {
      const countryId = top(g.countries);
      const regionId = top(g.regions);
      if (countryId) countryIds.add(countryId);
      if (regionId) regionIds.add(regionId);
      return { normalized, name: top(g.spellings), wineCount: g.total, countryId, regionId };
    }).sort((a, b) => b.wineCount - a.wineCount);

    const [countries, regions] = await Promise.all([
      Country.find({ _id: { $in: [...countryIds] } }).select('name').lean(),
      Region.find({ _id: { $in: [...regionIds] } }).select('name country').lean(),
    ]);
    const countryName = new Map(countries.map(c => [String(c._id), c.name]));
    const regionById = new Map(regions.map(r => [String(r._id), r]));

    res.json({
      total: items.length,
      items: items.map(i => {
        const region = i.regionId ? regionById.get(i.regionId) : null;
        return {
          ...i,
          countryName: i.countryId ? countryName.get(i.countryId) || null : null,
          // A majority region from a DIFFERENT country than the majority
          // country would violate the Appellation schema — drop it.
          regionId: region && String(region.country) === i.countryId ? i.regionId : null,
          regionName: region && String(region.country) === i.countryId ? region.name : null,
        };
      }),
    });
  } catch (error) {
    console.error('Unmatched appellations error:', error);
    res.status(500).json({ error: 'Failed to list unmatched appellations' });
  }
});

// GET /api/admin/taxonomy/appellations - List (filter by country and/or region)
router.get('/appellations', async (req, res) => {
  try {
    const { country, region } = req.query;
    const filter = {};
    if (country) {
      if (!mongoose.Types.ObjectId.isValid(country)) {
        return res.status(400).json({ error: 'Invalid country id' });
      }
      filter.country = country;
    }
    if (region) {
      if (!mongoose.Types.ObjectId.isValid(region)) {
        return res.status(400).json({ error: 'Invalid region id' });
      }
      filter.region = region;
    }

    const [appellations, wineCounts] = await Promise.all([
      Appellation.find(filter)
        .populate('country', 'name')
        .populate('region', 'name')
        .sort({ name: 1 })
        .lean(),
      wineCountsByAppellation(),
    ]);
    // Free-text join: wines carry the appellation as a string, so a doc's
    // usage is every wine whose normalized string matches its normalizedName.
    const rows = appellations.map(a => ({
      ...a,
      wineCount: wineCounts.get(a.normalizedName || normalizeAppellationKey(a.name || '')) || 0,
    }));

    res.json({ count: rows.length, appellations: rows });
  } catch (error) {
    console.error('Get appellations error:', error);
    res.status(500).json({ error: 'Failed to get appellations' });
  }
});

// POST /api/admin/taxonomy/appellations - Create appellation
router.post('/appellations', async (req, res) => {
  try {
    const { name, country, region, synonyms } = req.body;

    if (!name || !country) {
      return res.status(400).json({ error: 'Name and country are required' });
    }

    const normalizedName = normalizeAppellationKey(name);

    const appellation = new Appellation({
      name: name.trim(),
      normalizedName,
      country,
      region: region || null,
      synonyms: Array.isArray(synonyms) && synonyms.length ? synonyms : undefined,
      createdBy: req.user.id
    });

    await appellation.save();
    await appellation.populate('country', 'name');
    await appellation.populate('region', 'name');

    logAudit(req, 'admin.taxonomy.create',
      { type: 'appellation', id: appellation._id },
      { name: appellation.name }
    );
    res.status(201).json({ appellation });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Appellation already exists in this country' });
    }
    console.error('Create appellation error:', error);
    res.status(500).json({ error: 'Failed to create appellation' });
  }
});

// PUT /api/admin/taxonomy/appellations/:id - Update appellation
router.put('/appellations/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { name, region, synonyms } = req.body;

    const appellation = await Appellation.findById(req.params.id);
    if (!appellation) {
      return res.status(404).json({ error: 'Appellation not found' });
    }

    if (name) {
      appellation.name = name.trim();
      appellation.normalizedName = normalizeAppellationKey(name);
    }
    if (region !== undefined) appellation.region = region || null;
    if (synonyms !== undefined) appellation.synonyms = Array.isArray(synonyms) && synonyms.length ? synonyms : undefined;

    await appellation.save();
    await appellation.populate('country', 'name');
    await appellation.populate('region', 'name');
    logAudit(req, 'admin.taxonomy.update',
      { type: 'appellation', id: appellation._id },
      { name: appellation.name }
    );

    res.json({ appellation });
  } catch (error) {
    console.error('Update appellation error:', error);
    res.status(500).json({ error: 'Failed to update appellation' });
  }
});

// DELETE /api/admin/taxonomy/appellations/:id - Delete appellation
router.delete('/appellations/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const appellation = await Appellation.findById(req.params.id);
    if (!appellation) {
      return res.status(404).json({ error: 'Appellation not found' });
    }

    logAudit(req, 'admin.taxonomy.delete',
      { type: 'appellation', id: appellation._id },
      { name: appellation.name }
    );
    await appellation.deleteOne();
    res.json({ message: 'Appellation deleted successfully' });
  } catch (error) {
    console.error('Delete appellation error:', error);
    res.status(500).json({ error: 'Failed to delete appellation' });
  }
});

// ===== BOTTLE SIZES =====

// GET /api/admin/taxonomy/bottle-sizes - Distinct stored sizes + counts,
// plus the canonical reference list for the UI.
router.get('/bottle-sizes', async (req, res) => {
  try {
    const sizes = await distinctSizes();
    res.json({ sizes, canonical: BOTTLE_SIZES });
  } catch (error) {
    console.error('List bottle sizes error:', error);
    res.status(500).json({ error: 'Failed to list bottle sizes' });
  }
});

// POST /api/admin/taxonomy/bottle-sizes/remap - Bulk-remap one stored value
// to a canonical code. Body: { from, to }
router.post('/bottle-sizes/remap', async (req, res) => {
  try {
    const result = await remap(req.body.from, req.body.to);
    logAudit(req, 'admin.bottleSize.remap',
      { from: result.from, to: result.to },
      { modified: result.modified }
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Remap failed' });
  }
});

// POST /api/admin/taxonomy/bottle-sizes/normalize-all - Normalize every bottle
// to its canonical code in one pass.
router.post('/bottle-sizes/normalize-all', async (req, res) => {
  try {
    const result = await normalizeAll();
    logAudit(req, 'admin.bottleSize.normalizeAll', {}, result);
    res.json(result);
  } catch (error) {
    console.error('Normalize bottle sizes error:', error);
    res.status(500).json({ error: 'Failed to normalize bottle sizes' });
  }
});

module.exports = router;
