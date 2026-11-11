const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { normalizeString, sanitizeTaxonomyName } = require('../../utils/normalize');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Grape = require('../../models/Grape');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');
const { distinctSizes, normalizeAll, remap } = require('../../services/bottleSizeMaintenance');
const { mergeGrapes, mergeRegions, mergeCountries } = require('../../services/taxonomyMerge');
const { findDuplicateClusters } = require('../../utils/taxonomyDuplicates');
const { sanitizeTranslations } = require('../../utils/localizedName');
const { validateGrapeRegionalNames, computeRegionalNameWarnings } = require('../../services/grapeRegionalNames');
const { BOTTLE_SIZES } = require('../../config/bottleSizes');
const { needsHumanReview, wineCountsByRef, wineCountsByGrape } = require('../../services/taxonomyUsage');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// Public taxonomy lists are served from a 10-minute server-side cache —
// drop it after any successful admin mutation so renames/deletions show up
// immediately instead of after the TTL.
const { clearTaxonomyListCache } = require('../taxonomy');

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
      // Audit 2026-09 D01-1: same cap + control-character strip as Region/Grape.
      name: sanitizeTaxonomyName(name),
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
      country.name = sanitizeTaxonomyName(name);
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

    // Resync the registry index if the name changed (denormalized data).
    // Cellar search (services/bottleSearch) reads names live from MongoDB.
    if (name) searchService.fullSync();

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

    // Grape regional display names reference countries too — a dangling
    // country ref would silently fall back to the canonical name AND brick
    // that grape's next regionalNames save (same guard region DELETE has).
    const grapeRef = await Grape.exists({ 'regionalNames.country': req.params.id });
    if (grapeRef) {
      return res.status(400).json({
        error: 'Cannot delete country. A grape regional display name references it.'
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
    const rows = regions.map(r => {
      const wineCount = wineCounts.get(String(r._id)) || 0;
      return { ...r, wineCount, needsReview: needsHumanReview(r, wineCount) };
    });

    res.json({
      count: rows.length,
      regions: rows,
      // What the screen should actually draw attention to — see
      // needsHumanReview. createdByUser stays on every row untouched.
      needsReviewCount: rows.filter(r => r.needsReview).length,
    });
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
      // Bounded like every other write path — the display name is stored
      // separately from normalizedName and was only trimmed, so it could hold
      // newlines and unbounded length (security audit 2026-08-03).
      name: sanitizeTaxonomyName(name),
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
      // Rename is the path that made a create-only guard pointless: a region
      // minted correctly could be renamed to anything afterwards.
      region.name = sanitizeTaxonomyName(name);
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

    // Resync the registry index if the name changed (denormalized data).
    // Cellar search (services/bottleSearch) reads names live from MongoDB.
    if (name) searchService.fullSync();

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

    // Check if any grape carries a regional display name scoped to this
    // region. A dangling ref would not crash resolution (idOf simply never
    // matches) but it WOULD silently drop curated display data; merge is the
    // path that preserves it (regionalNames are re-pointed there).
    const grapeRefs = await Grape.exists({ 'regionalNames.region': req.params.id });
    if (grapeRefs) {
      return res.status(400).json({
        error: 'Cannot delete region. Grape regional display name(s) reference it.'
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
    const rows = grapes.map(g => {
      const wineCount = wineCounts.get(String(g._id)) || 0;
      return { ...g, wineCount, needsReview: needsHumanReview(g, wineCount) };
    });
    res.json({
      count: rows.length,
      grapes: rows,
      needsReviewCount: rows.filter(g => g.needsReview).length,
    });
  } catch (error) {
    console.error('Get grapes error:', error);
    res.status(500).json({ error: 'Failed to get grapes' });
  }
});

// POST /api/admin/taxonomy/grapes - Add grape
router.post('/grapes', async (req, res) => {
  try {
    const { name, synonyms, color, origin, characteristics, agingPotential, prestige, description, regionalNames } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Grape name is required' });
    }

    // The create and update forms share the grape editor, so both routes
    // accept regionalNames — a field the UI offers but the API drops would be
    // silent data loss.
    let regionalNamesValue = [];
    if (regionalNames !== undefined) {
      const check = await validateGrapeRegionalNames(regionalNames);
      if (check.error) return res.status(400).json({ error: check.error });
      regionalNamesValue = check.value;
    }

    const normalizedName = normalizeString(name);

    const grape = new Grape({
      name: sanitizeTaxonomyName(name),
      normalizedName,
      synonyms: synonyms || [],
      color: color || null,
      origin: origin || null,
      characteristics: characteristics || [],
      agingPotential: agingPotential || null,
      prestige: prestige || null,
      description: stripHtml(typeof description === 'string' ? description : ''),
      regionalNames: regionalNamesValue,
      createdBy: req.user.id
    });

    await grape.save();
    logAudit(req, 'admin.taxonomy.create',
      { type: 'grape', id: grape._id },
      { name: grape.name }
    );
    // Non-blocking curator-trap warnings (see computeRegionalNameWarnings) —
    // present only when at least one regional name cannot be written back.
    const warnings = computeRegionalNameWarnings(regionalNamesValue, {
      name: grape.name,
      normalizedName: grape.normalizedName,
      synonyms: grape.synonyms,
    });
    res.status(201).json({ grape, ...(warnings.length ? { regionalNameWarnings: warnings } : {}) });
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
    const { name, synonyms, color, origin, characteristics, agingPotential, prestige, description, regionalNames } = req.body;

    const grape = await Grape.findById(req.params.id);
    if (!grape) {
      return res.status(404).json({ error: 'Grape not found' });
    }

    // Validate before mutating anything, so a rejected payload leaves the
    // loaded doc untouched.
    let regionalNamesValue;
    if (regionalNames !== undefined) {
      const check = await validateGrapeRegionalNames(regionalNames);
      if (check.error) return res.status(400).json({ error: check.error });
      regionalNamesValue = check.value;
    }

    if (name) {
      grape.name = sanitizeTaxonomyName(name);
      grape.normalizedName = normalizeString(name);
    }
    if (synonyms !== undefined) grape.synonyms = synonyms;
    if (color !== undefined) grape.color = color;
    if (origin !== undefined) grape.origin = origin;
    if (characteristics !== undefined) grape.characteristics = characteristics;
    if (agingPotential !== undefined) grape.agingPotential = agingPotential;
    if (prestige !== undefined) grape.prestige = prestige;
    if (description !== undefined) grape.description = stripHtml(typeof description === 'string' ? description : '');
    if (regionalNamesValue !== undefined) grape.regionalNames = regionalNamesValue;

    await grape.save();
    logAudit(req, 'admin.taxonomy.update',
      { type: 'grape', id: grape._id },
      {
        name: grape.name,
        ...(regionalNames !== undefined ? { regionalNames: grape.regionalNames.length } : {})
      }
    );

    // Resync the registry index if the name changed (denormalized data).
    // regionalNames feed its grapeNames too (regional display recall), so a
    // mapping change rebuilds it as well. Cellar search (services/bottleSearch)
    // reads both live from MongoDB.
    if (name || regionalNames !== undefined) {
      searchService.fullSync();
    }

    // Non-blocking curator-trap warnings (see computeRegionalNameWarnings),
    // computed AFTER the assignments above so an incoming rename/synonym list
    // wins over the stored doc's fields.
    let warnings = [];
    if (regionalNamesValue !== undefined) {
      warnings = computeRegionalNameWarnings(regionalNamesValue, {
        name: grape.name,
        normalizedName: grape.normalizedName,
        synonyms: grape.synonyms,
      });
    }
    res.json({ grape, ...(warnings.length ? { regionalNameWarnings: warnings } : {}) });
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

// POST /api/admin/taxonomy/regions/:id/approve — record that a human looked
// a user-write mint set (strategy 2026-07-29 R3). Approval is its own verb,
// not a PUT side effect: editing a region to fix a typo must not silently
// count as "a human vouched for this".
// ── Display-name translations ────────────────────────────────────────────────

// Only the two taxonomies that genuinely change language. Appellations are
// protected legal names (Côte-Rôtie is Côte-Rôtie everywhere) and grape
// variation is REGIONAL rather than linguistic — models/Grape already carries
// `regionalNames` for that. See utils/localizedName for the full reasoning.
const TRANSLATABLE = { countries: Country, regions: Region };

/**
 * PUT /api/admin/taxonomy/:kind/:id/translations
 * Body: { translations: { fr: "Vallée du Rhône", de: "Rhônetal" } }
 *
 * A full replacement, not a merge: a language absent from the body is REMOVED.
 * That is the only shape in which an editor can delete a wrong translation,
 * and a merge-only endpoint would leave one stuck for good.
 */
router.put('/:kind(countries|regions)/:id/translations', async (req, res) => {
  try {
    const Model = TRANSLATABLE[req.params.kind];
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const parsed = sanitizeTranslations(req.body?.translations);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const doc = await Model.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const before = doc.translations ? Object.fromEntries(doc.translations) : {};
    const languages = Object.keys(parsed.translations);
    // undefined, not an empty Map: the field's default is undefined, and
    // storing an empty Map would leave every untranslated doc carrying one.
    doc.translations = languages.length ? parsed.translations : undefined;
    await doc.save();

    clearTaxonomyListCache();
    logAudit(req, `taxonomy.${req.params.kind}.translations`, { type: req.params.kind === 'countries' ? 'Country' : 'Region', id: doc._id }, {
      name: doc.name, before, after: parsed.translations,
    });

    res.json({ id: doc._id, name: doc.name, translations: parsed.translations });
  } catch (err) {
    console.error('Update taxonomy translations error:', err);
    res.status(500).json({ error: 'Failed to update translations' });
  }
});

router.post('/regions/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const region = await Region.findById(req.params.id);
    if (!region) return res.status(404).json({ error: 'Region not found' });
    // Idempotent like the MCP tool: a second click must not write a second
    // audit entry for a no-op (audit 2026-07-29, REST/MCP drift).
    if (region.reviewedAt) return res.json({ region, already: true });
    // Stamp the review. createdByUser is NEVER cleared: it records where the
    // document came from, which stays true however many people look at it.
    region.reviewedAt = new Date();
    region.reviewedBy = req.user.id;
    await region.save();
    logAudit(req, 'admin.taxonomy.approveRegion',
      { type: 'region', id: region._id },
      { name: region.name }
    );
    res.json({ region });
  } catch (error) {
    console.error('Approve region error:', error);
    res.status(500).json({ error: 'Failed to approve region' });
  }
});

// POST /api/admin/taxonomy/grapes/:id/approve — record that a human looked
// a user-write mint set (bottle-add and import can mint a grape straight
// into the shared taxonomy). Mirrors the
// regions verb above: approval is its own verb, not a PUT side effect —
// editing a grape to fix a typo must not silently count as "a human vouched
// for this". A near-miss mint gets MERGED from the queue instead (the
// existing grapes/merge route), never silently substituted at add time.
router.post('/grapes/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const grape = await Grape.findById(req.params.id);
    if (!grape) return res.status(404).json({ error: 'Grape not found' });
    // Idempotent like the regions verb: a second click must not write a
    // second audit entry for a no-op.
    if (grape.reviewedAt) return res.json({ grape, already: true });
    grape.reviewedAt = new Date();
    grape.reviewedBy = req.user.id;
    await grape.save();
    logAudit(req, 'admin.taxonomy.approveGrape',
      { type: 'grape', id: grape._id },
      { name: grape.name }
    );
    res.json({ grape });
  } catch (error) {
    console.error('Approve grape error:', error);
    res.status(500).json({ error: 'Failed to approve grape' });
  }
});

// GET /api/admin/taxonomy/regions/duplicate-candidates
//
// Regions that are the same place under different names. Built after the Loire
// was found split across FOUR documents holding 208 wines between them
// (2026-08-31) — a split nothing surfaced, because the names share almost no
// characters and the registry's fuzzy wine scan cannot see it.
//
// utils/taxonomyDuplicates explains the rule and why its stop list is short.
// The output is a PROPOSAL: every cluster is merged by hand through the merge
// route below, which is what keeps a wrong signature from costing anything.
//
// Each cluster names a suggested target — the member with the most wines, or
// the reviewed one on a tie — because merging into the smaller document would
// re-point more rows than necessary and discard the doc appellations already
// reference.
router.get('/regions/duplicate-candidates', async (req, res) => {
  try {
    // Country names come from a SEPARATE lookup, not .populate(). Populating
    // destroys what the country scope depends on: a dangling ref makes
    // Mongoose null the path and take the raw ObjectId with it, so every
    // unresolvable region would collapse into one empty scope and same-named
    // regions in DIFFERENT countries would cluster — the merge this scan must
    // never propose (a Georgia in the United States is not the country's
    // namesake). The guard fails CLOSED: a region whose country cannot be
    // resolved is skipped and counted, never grouped with strangers.
    const [regions, countries] = await Promise.all([
      Region.find({}).select('name country createdByUser reviewedAt synonyms').lean(),
      Country.find({}).select('name').lean(),
    ]);
    const countryNames = new Map(countries.map((c) => [String(c._id), c.name]));

    const scopable = [];
    let unscopableCount = 0;
    for (const r of regions) {
      const scope = r.country ? String(r.country) : '';
      if (!scope) { unscopableCount++; continue; }
      scopable.push({ ...r, scope, countryName: countryNames.get(scope) || null });
    }

    const clusters = findDuplicateClusters(scopable);
    if (clusters.length === 0) {
      return res.json({ clusters: [], scannedCount: regions.length, unscopableCount });
    }

    // One grouped count for every candidate rather than a query per member.
    const memberIds = clusters.flatMap((c) => c.members.map((m) => m._id));
    const counts = new Map(
      (await WineDefinition.aggregate([
        // Quarantined and pending-identity rows are not "in use" — the same
        // exclusion wineCountsByRef() applies (services/taxonomyUsage), so this screen and the
        // taxonomy list agree about the same region. It also decides the merge
        // TARGET below: without it, a document whose bulk is quarantined junk
        // could outrank the real region and pull its wines into itself.
        { $match: { region: { $in: memberIds }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
        { $group: { _id: '$region', n: { $sum: 1 } } },
      ])).map((row) => [String(row._id), row.n])
    );

    const out = clusters.map((c) => {
      const members = c.members
        .map((m) => ({
          _id: m._id,
          name: m.name,
          country: m.countryName || null,
          wineCount: counts.get(String(m._id)) || 0,
          createdByUser: !!m.createdByUser,
          reviewedAt: m.reviewedAt || null,
          synonyms: m.synonyms || [],
        }))
        .sort((a, b) => b.wineCount - a.wineCount
          || (!!a.reviewedAt === !!b.reviewedAt ? 0 : a.reviewedAt ? -1 : 1));
      return {
        signature: c.signature,
        country: members[0]?.country || null,
        suggestedTargetId: members[0]?._id || null,
        totalWines: members.reduce((sum, m) => sum + m.wineCount, 0),
        members,
      };
    }).sort((a, b) => b.totalWines - a.totalWines);

    res.json({ clusters: out, scannedCount: regions.length, unscopableCount });
  } catch (error) {
    console.error('Region duplicate scan error:', error);
    res.status(500).json({ error: 'Failed to scan for duplicate regions' });
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
      // Affected wines are reindexed by the service.
      res.json({ merged: true, ...summary });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error(`Merge ${type} error:`, error);
      res.status(500).json({ error: `Failed to merge ${type}` });
    }
  });
}


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
    // from/to in detail: resource is a typed sub-document, so keys it does
    // not know are dropped from the stored row.
    logAudit(req, 'admin.bottleSize.remap',
      { type: 'bottleSize' },
      { from: result.from, to: result.to, modified: result.modified }
    );
    res.json(result);
  } catch (error) {
    // Bad input is the caller's to fix (400, with the reason); anything else
    // is ours (500, logged, no internals sent back).
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('Remap bottle size error:', error);
    res.status(500).json({ error: 'Remap failed' });
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

// The appellation, classification and sweetness-term routes have their own
// files. They are mounted after the cache-clearing middleware at the top of
// this file, so a write in them drops the public taxonomy list cache too.
const appellationRoutes = require('./taxonomyAppellations');
router.use(appellationRoutes);
router.use(require('./taxonomyClassifications'));
router.use(require('./taxonomySweetnessTerms'));

module.exports = router;
// The appellation input validators live in routes/admin/taxonomyAppellations;
// re-exported here for taxonomy.appellationInput.test.js, which reads them
// from this router.
module.exports.appellationNameError = appellationRoutes.appellationNameError;
module.exports.validateAppellationSynonyms = appellationRoutes.validateAppellationSynonyms;
// The grape regional-name validators live in services/grapeRegionalNames;
// re-exported here for taxonomy.grapeRegionalNames.test.js, which tests them
// through the router (the DB lookups inside are mocked there).
module.exports.validateGrapeRegionalNames = validateGrapeRegionalNames;
// Pure and DB-free — re-exported for the same suite.
module.exports.computeRegionalNameWarnings = computeRegionalNameWarnings;
