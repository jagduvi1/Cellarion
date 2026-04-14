const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { normalizeString } = require('../../utils/normalize');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Grape = require('../../models/Grape');
const Appellation = require('../../models/Appellation');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// ===== COUNTRIES =====

// GET /api/admin/taxonomy/countries - List all countries
router.get('/countries', async (req, res) => {
  try {
    const countries = await Country.find().sort({ name: 1 });
    res.json({ count: countries.length, countries });
  } catch (error) {
    console.error('Get countries error:', error);
    res.status(500).json({ error: 'Failed to get countries' });
  }
});

// POST /api/admin/taxonomy/countries - Add country
router.post('/countries', async (req, res) => {
  try {
    const { name, code } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Country name is required' });
    }

    const normalizedName = normalizeString(name);

    const country = new Country({
      name: name.trim(),
      code: code?.trim().toUpperCase(),
      normalizedName,
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
    const { name, code } = req.body;

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

    await country.save();

    // Resync search index if name changed (denormalized data)
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

    const regions = await Region.find(filter)
      .populate('country', 'name')
      .populate('parentRegion', 'name')
      .populate('typicalGrapes', 'name')
      .populate('permittedGrapes', 'name')
      .sort({ name: 1 });

    res.json({ count: regions.length, regions });
  } catch (error) {
    console.error('Get regions error:', error);
    res.status(500).json({ error: 'Failed to get regions' });
  }
});

// POST /api/admin/taxonomy/regions - Add region
router.post('/regions', async (req, res) => {
  try {
    const { name, country, parentRegion, classification, styles,
            agingRules, prestigeLevel, typicalGrapes, permittedGrapes } = req.body;

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
    const { name, parentRegion, classification, styles,
            agingRules, prestigeLevel, typicalGrapes, permittedGrapes } = req.body;

    const region = await Region.findById(req.params.id);
    if (!region) {
      return res.status(404).json({ error: 'Region not found' });
    }

    if (name) {
      region.name = name.trim();
      region.normalizedName = normalizeString(name);
    }

    if (parentRegion !== undefined) {
      region.parentRegion = parentRegion || null;

      // Rebuild hierarchy
      const hierarchy = [];
      if (parentRegion) {
        const parent = await Region.findById(parentRegion);
        if (parent) {
          hierarchy.push(...parent.hierarchy);
        }
      }
      hierarchy.push(region.name);
      region.hierarchy = hierarchy;
    }

    if (classification !== undefined) region.classification = classification;
    if (styles !== undefined) region.styles = styles;
    if (agingRules !== undefined) region.agingRules = agingRules;
    if (prestigeLevel !== undefined) region.prestigeLevel = prestigeLevel;
    if (typicalGrapes !== undefined) region.typicalGrapes = typicalGrapes;
    if (permittedGrapes !== undefined) region.permittedGrapes = permittedGrapes;

    await region.save();
    await region.populate('country', 'name');
    await region.populate('typicalGrapes', 'name');
    await region.populate('permittedGrapes', 'name');

    // Resync search index if name changed (denormalized data)
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
    const grapes = await Grape.find().sort({ name: 1 });
    res.json({ count: grapes.length, grapes });
  } catch (error) {
    console.error('Get grapes error:', error);
    res.status(500).json({ error: 'Failed to get grapes' });
  }
});

// POST /api/admin/taxonomy/grapes - Add grape
router.post('/grapes', async (req, res) => {
  try {
    const { name, synonyms, color, origin, characteristics, agingPotential, prestige } = req.body;

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
    const { name, synonyms, color, origin, characteristics, agingPotential, prestige } = req.body;

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

    await grape.save();

    // Resync search index if name changed (denormalized data)
    if (name) searchService.fullSync();

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

// ===== APPELLATIONS =====

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

    const appellations = await Appellation.find(filter)
      .populate('country', 'name')
      .populate('region', 'name')
      .sort({ name: 1 });

    res.json({ count: appellations.length, appellations });
  } catch (error) {
    console.error('Get appellations error:', error);
    res.status(500).json({ error: 'Failed to get appellations' });
  }
});

// POST /api/admin/taxonomy/appellations - Create appellation
router.post('/appellations', async (req, res) => {
  try {
    const { name, country, region } = req.body;

    if (!name || !country) {
      return res.status(400).json({ error: 'Name and country are required' });
    }

    const normalizedName = normalizeString(name);

    const appellation = new Appellation({
      name: name.trim(),
      normalizedName,
      country,
      region: region || null,
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
    const { name, region } = req.body;

    const appellation = await Appellation.findById(req.params.id);
    if (!appellation) {
      return res.status(404).json({ error: 'Appellation not found' });
    }

    if (name) {
      appellation.name = name.trim();
      appellation.normalizedName = normalizeString(name);
    }
    if (region !== undefined) appellation.region = region || null;

    await appellation.save();
    await appellation.populate('country', 'name');
    await appellation.populate('region', 'name');

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

module.exports = router;
