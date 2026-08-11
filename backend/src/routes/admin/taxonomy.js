const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { normalizeString, normalizeAppellation, normalizeAppellationKey, sanitizeTaxonomyName, resolveGrapeName } = require('../../utils/normalize');
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
const { listUnmatchedAppellations, appellationRefsError } = require('../../services/taxonomyReview');
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
    // Quarantined rows don't count as "in use" — mirror taxonomyReview.js.
    { $match: { [field]: { $ne: null }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [String(r._id), r.n]));
}

/** Map<grapeIdString, wineCount> (grapes is an array field). */
async function wineCountsByGrape() {
  const rows = await WineDefinition.aggregate([
    { $match: { nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
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
    { $match: { appellation: { $nin: [null, ''] }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
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

// ── Regional display names validation ────────────────────────────────────────
// Grape.regionalNames = [{ country, region?, name }] — regionally correct
// display labels ("Tinta Roriz" for Tempranillo on Douro wines; see
// models/Grape.js). Bounded and ref-checked here because Mongoose validates
// neither that the ids exist nor that the region belongs to the country.
const REGIONAL_NAMES_MAX = 20;
const REGIONAL_NAME_MAX_LENGTH = 60; // == the schema's maxlength

/**
 * Validate a regionalNames payload. Returns { error } (human-readable, safe
 * for a 400 body) or { value } — the cleaned array: trimmed names, ids as
 * strings, region null when absent.
 *
 * Same discipline as taxonomyReview.appellationRefsError: every id is
 * isValidId-checked and the validated STRING is what reaches the query, so
 * operator objects from the request body never enter a filter.
 */
async function validateGrapeRegionalNames(input) {
  if (!Array.isArray(input)) {
    return { error: 'regionalNames must be an array of { country, region?, name } entries' };
  }
  if (input.length > REGIONAL_NAMES_MAX) {
    return { error: `At most ${REGIONAL_NAMES_MAX} regional names per grape` };
  }
  const value = [];
  const seenPairs = new Set();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'regionalNames must be an array of { country, region?, name } entries' };
    }
    // Same bounding grape.name gets (utils/normalize): control characters
    // become spaces, whitespace collapses, length is capped — a regional name
    // is substituted into the same display/search surfaces, so a newline or a
    // zero-width char must not survive here either (returns '' for
    // non-strings, which the emptiness check below rejects).
    const name = sanitizeTaxonomyName(entry.name);
    if (!name) return { error: 'Each regional name needs a non-empty name' };
    if (name.length > REGIONAL_NAME_MAX_LENGTH) {
      return { error: `Regional names must be ${REGIONAL_NAME_MAX_LENGTH} characters or fewer` };
    }
    const countryKey = String(entry.country ?? '');
    if (!isValidId(countryKey)) return { error: 'Each regional name needs a valid country id' };
    const countryExists = await Country.exists({ _id: countryKey });
    if (!countryExists) return { error: 'No country with that id' };
    let regionKey = null;
    if (entry.region) {
      regionKey = String(entry.region);
      if (!isValidId(regionKey)) return { error: 'Invalid region id in regional names' };
      const region = await Region.findById(regionKey).select('name country').lean();
      if (!region) return { error: 'No region with that id' };
      if (String(region.country) !== countryKey) {
        return { error: `Region "${region.name}" belongs to a different country than the regional name's country` };
      }
    }
    // One display name per place — a duplicate (country, region) pair would
    // make resolution order-dependent.
    const pairKey = `${countryKey}:${regionKey || ''}`;
    if (seenPairs.has(pairKey)) {
      return { error: 'Duplicate (country, region) pair in regional names — each place carries one display name' };
    }
    seenPairs.add(pairKey);
    value.push({ country: countryKey, region: regionKey, name });
  }
  return { value };
}

/**
 * Curator-trap check: a regional name that is NOT also a synonym of its grape
 * DISPLAYS fine, but cannot be written back — a curator reading "Tinta Roriz"
 * off a wine card and typing it into set_wine_profile gets "unknown variety",
 * because resolveGrapeIdsStrict matches normalizedName + normalizedSynonyms
 * only. Runs the exact fold that write path runs
 * (normalizeString(resolveGrapeName(name))) against the grape AS IT WILL BE
 * SAVED. Non-blocking by house doctrine — a display name is legitimate
 * without being a synonym; flag, never block.
 *
 * @param {Array<{name:string}>} entries  validated regionalNames
 * @param {{name:string, normalizedName:string, synonyms?:string[]}} grape
 *        effective fields (incoming values win over the stored doc's)
 * @returns {string[]} one warning per non-writable name; [] when all write back
 */
function computeRegionalNameWarnings(entries, { name, normalizedName, synonyms }) {
  const writable = new Set(
    [normalizedName, ...(synonyms || []).map(normalizeString)].filter(Boolean)
  );
  const warnings = [];
  for (const entry of entries) {
    const key = normalizeString(resolveGrapeName(entry.name));
    if (key && writable.has(key)) continue;
    warnings.push(
      `'${entry.name}' is not a synonym of ${name} — curators cannot write it back via set_wine_profile; add it as a synonym too`
    );
  }
  return warnings;
}

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
      description: description || '',
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
    if (description !== undefined) grape.description = description;
    if (regionalNamesValue !== undefined) grape.regionalNames = regionalNamesValue;

    await grape.save();
    logAudit(req, 'admin.taxonomy.update',
      { type: 'grape', id: grape._id },
      {
        name: grape.name,
        ...(regionalNames !== undefined ? { regionalNames: grape.regionalNames.length } : {})
      }
    );

    // Resync search indexes if name changed (denormalized data). Bottle
    // documents denormalize taxonomy names too — fullSync() alone rebuilds
    // only the wines index, leaving cellar search matching the old name.
    // regionalNames feed the grapeNames of BOTH indexes (regional display
    // recall — buildDocument and buildBottleDocument share the same helper),
    // so a mapping change rebuilds both as well.
    if (name || regionalNames !== undefined) {
      searchService.fullSync();
      searchService.fullSyncBottles();
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

// POST /api/admin/taxonomy/regions/:id/approve — clear the pendingReview flag
// a user-write mint set (strategy 2026-07-29 R3). Approval is its own verb,
// not a PUT side effect: editing a region to fix a typo must not silently
// count as "a human vouched for this".
router.post('/regions/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const region = await Region.findById(req.params.id);
    if (!region) return res.status(404).json({ error: 'Region not found' });
    // Idempotent like the MCP tool: a second click must not write a second
    // audit entry for a no-op (audit 2026-07-29, REST/MCP drift).
    if (!region.pendingReview) return res.json({ region, already: true });
    region.pendingReview = false;
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

// Input validation for the two write routes below, mirroring the MCP
// promote_appellation schema byte-for-byte (name ≤200; synonyms at most 10
// strings of ≤200 chars) so the two curation surfaces cannot drift. REST
// previously validated neither the synonym element type nor the array length,
// and normalizedSynonyms is an INDEXED multikey field, so an unbounded array
// grew the index — while a non-string element failed the Mongoose cast into a
// 500 (security audit 2026-07-30 L-1).
const APPELLATION_NAME_MAX = 200;
const APPELLATION_SYNONYMS_MAX = 10;

/**
 * typeof, not truthiness (security audit 2026-07-30 L-2): a JSON body value
 * like {"$ne":null} is truthy, and the .trim() below would throw a TypeError
 * that the route's catch turns into a 500. Nothing is exploitable — it throws
 * before any Mongo query — but the answer should be a 400.
 *
 * @returns {string|null} the error message, or null when the name is valid.
 */
function appellationNameError(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Appellation name is required';
  // The mint chokepoint caps wine fields at 200; a longer curated name would be
  // adopted onto wines past that cap (audit 2026-07-29 A1).
  if (name.trim().length > APPELLATION_NAME_MAX) {
    return `Appellation name must be ${APPELLATION_NAME_MAX} characters or fewer`;
  }
  return null;
}

/**
 * @returns {{error: string}|{value: string[]|undefined}} trimmed, de-duplicated
 *   synonyms — `undefined` rather than [] when nothing survives, matching the
 *   schema's `default: undefined` so an empty list leaves no array behind for
 *   the normalizedSynonyms lookup to scan.
 */
function validateAppellationSynonyms(synonyms) {
  if (!Array.isArray(synonyms)) return { error: 'synonyms must be an array of strings' };
  if (synonyms.length > APPELLATION_SYNONYMS_MAX) {
    return { error: `At most ${APPELLATION_SYNONYMS_MAX} synonyms per appellation` };
  }
  const out = [];
  const seen = new Set();
  for (const raw of synonyms) {
    if (typeof raw !== 'string') return { error: 'synonyms must be an array of strings' };
    const value = raw.trim().replace(/\s+/g, ' ');
    if (!value) continue;
    if (value.length > APPELLATION_NAME_MAX) {
      return { error: `Each synonym must be ${APPELLATION_NAME_MAX} characters or fewer` };
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue; // an admin pasting a list shouldn't create dupes
    seen.add(key);
    out.push(value);
  }
  return { value: out.length ? out : undefined };
}

// GET /api/admin/taxonomy/appellations/unmatched — the appellation review
// queue (strategy 2026-07-29 R2). Wines store appellations as free text; this
// lists every distinct normalized string that NO curated Appellation doc (by
// name or synonym) covers, with the majority display spelling and the
// majority country/region so the admin can promote it in one click (the
// existing create endpoint) or fix the wines. Unknown values are reviewed,
// never rejected — adding a bottle must not be blocked by taxonomy.
router.get('/appellations/unmatched', async (req, res) => {
  try {
    const items = await listUnmatchedAppellations();
    res.json({ total: items.length, items });
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

    const nameError = appellationNameError(name);
    if (nameError) return res.status(400).json({ error: nameError });
    if (!country) {
      return res.status(400).json({ error: 'Country is required' });
    }
    // Both refs verified: the ids must exist and the region must belong to the
    // country (code audit 2026-07-30) — the schema declares the refs but
    // enforces neither, so a cross-country region would sit silently wrong in
    // curated taxonomy until the appellation-hierarchy work inherited it.
    const refsError = await appellationRefsError(country, region);
    if (refsError) return res.status(400).json({ error: refsError });

    let cleanSynonyms;
    if (synonyms !== undefined && synonyms !== null) {
      const checked = validateAppellationSynonyms(synonyms);
      if (checked.error) return res.status(400).json({ error: checked.error });
      cleanSynonyms = checked.value;
    }

    const normalizedName = normalizeAppellationKey(name);

    const appellation = new Appellation({
      name: name.trim(),
      normalizedName,
      country,
      region: region || null,
      synonyms: cleanSynonyms,
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

    // An absent name leaves it alone (partial update); a PRESENT one is
    // validated, so a non-string can no longer reach .trim().
    if (name !== undefined && name !== null) {
      const nameError = appellationNameError(name);
      if (nameError) return res.status(400).json({ error: nameError });
      appellation.name = name.trim();
      appellation.normalizedName = normalizeAppellationKey(name);
    }
    if (region !== undefined) {
      // Clearing (null/'') is always fine; SETTING a region re-validates it
      // against the appellation's country — update was the easiest drift path,
      // since a correctly created doc could be re-pointed at any region.
      if (region) {
        const refsError = await appellationRefsError(appellation.country, region);
        if (refsError) return res.status(400).json({ error: refsError });
      }
      appellation.region = region || null;
    }
    if (synonyms !== undefined) {
      // null clears the list, matching how the rest of the admin surface
      // distinguishes "leave alone" (absent) from "clear" (explicit null).
      if (synonyms === null) {
        appellation.synonyms = undefined;
      } else {
        const checked = validateAppellationSynonyms(synonyms);
        if (checked.error) return res.status(400).json({ error: checked.error });
        appellation.synonyms = checked.value;
      }
    }

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
// The appellation input validators are exported for their unit tests (same
// pattern as admin/import.js mapRow): they are pure and DB-free, and they are
// the half of the REST/MCP parity contract that lives on this side.
module.exports.appellationNameError = appellationNameError;
module.exports.validateAppellationSynonyms = validateAppellationSynonyms;
// Exported for its unit tests (taxonomy.grapeRegionalNames.test.js) — the DB
// lookups inside are mocked there.
module.exports.validateGrapeRegionalNames = validateGrapeRegionalNames;
// Pure and DB-free — exported for the same suite.
module.exports.computeRegionalNameWarnings = computeRegionalNameWarnings;
