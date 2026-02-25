const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const {
  generateWineKey,
  calculateSimilarity,
  combinedSimilarity,
  trigramSimilarity,
  tokenSimilarity
} = require('../../utils/normalize');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// POST /api/admin/wines - Create wine definition
router.post('/', async (req, res) => {
  try {
    const { name, producer, country, region, appellation, grapes, type, image } = req.body;

    if (!name || !producer || !country) {
      return res.status(400).json({ error: 'Name, producer, and country are required' });
    }

    // Generate normalized key for deduplication
    const normalizedKey = generateWineKey(name, producer, appellation);

    const wine = new WineDefinition({
      name: name.trim(),
      producer: producer.trim(),
      country,
      region: region || null,
      appellation: appellation?.trim(),
      grapes: grapes || [],
      type: type || 'red',
      image: image || null,
      normalizedKey,
      createdBy: req.user.id
    });

    await wine.save();
    await wine.populate(['country', 'region', 'grapes']);

    // Sync to search index (fire-and-forget)
    searchService.indexWine(wine._id);

    logAudit(req, 'admin.wine.create',
      { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer }
    );

    res.status(201).json({ wine });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        error: 'Wine already exists with this name, producer, and appellation combination'
      });
    }
    console.error('Create wine error:', error);
    res.status(500).json({ error: 'Failed to create wine' });
  }
});

// GET /api/admin/wines/duplicates - Find potential duplicates
router.get('/duplicates', async (req, res) => {
  try {
    const { name, producer, appellation, threshold = 0.75 } = req.query;

    if (!name || !producer) {
      return res.status(400).json({ error: 'Name and producer are required' });
    }

    // Use text search first to narrow down candidates
    let query = WineDefinition.find();

    // Try to use text search for initial filtering
    const searchTerms = `${name} ${producer}`.trim();
    if (searchTerms) {
      query = query.or([
        { $text: { $search: searchTerms } },
        { name: new RegExp(name.split(' ')[0], 'i') },
        { producer: new RegExp(producer.split(' ')[0], 'i') }
      ]);
    }

    const allWines = await query
      .populate(['country', 'region', 'grapes'])
      .limit(200); // Increased limit for better coverage

    // Calculate comprehensive similarity scores
    const candidates = allWines
      .map(wine => {
        // Name similarity (multiple algorithms)
        const nameLevenshtein = calculateSimilarity(name, wine.name);
        const nameTrigram = trigramSimilarity(name, wine.name);
        const nameToken = tokenSimilarity(name, wine.name);
        const nameCombined = combinedSimilarity(name, wine.name);

        // Producer similarity
        const producerLevenshtein = calculateSimilarity(producer, wine.producer);
        const producerTrigram = trigramSimilarity(producer, wine.producer);
        const producerToken = tokenSimilarity(producer, wine.producer);
        const producerCombined = combinedSimilarity(producer, wine.producer);

        // Appellation similarity (if provided)
        let appellationSimilarity = 1.0;
        if (appellation && wine.appellation) {
          appellationSimilarity = combinedSimilarity(appellation, wine.appellation);
        } else if (appellation || wine.appellation) {
          // One has appellation, other doesn't - slight penalty
          appellationSimilarity = 0.5;
        }

        // Overall similarity: name and producer weighted heavily
        const overallSimilarity =
          nameCombined * 0.45 +
          producerCombined * 0.45 +
          appellationSimilarity * 0.1;

        return {
          wine,
          similarity: overallSimilarity,
          scores: {
            name: {
              levenshtein: Math.round(nameLevenshtein * 100) / 100,
              trigram: Math.round(nameTrigram * 100) / 100,
              token: Math.round(nameToken * 100) / 100,
              combined: Math.round(nameCombined * 100) / 100
            },
            producer: {
              levenshtein: Math.round(producerLevenshtein * 100) / 100,
              trigram: Math.round(producerTrigram * 100) / 100,
              token: Math.round(producerToken * 100) / 100,
              combined: Math.round(producerCombined * 100) / 100
            },
            appellation: Math.round(appellationSimilarity * 100) / 100,
            overall: Math.round(overallSimilarity * 100) / 100
          }
        };
      })
      .filter(item => item.similarity >= parseFloat(threshold))
      .sort((a, b) => b.similarity - a.similarity);

    res.json({
      count: candidates.length,
      threshold: parseFloat(threshold),
      query: { name, producer, appellation },
      candidates
    });
  } catch (error) {
    console.error('Find duplicates error:', error);
    res.status(500).json({ error: 'Failed to find duplicates' });
  }
});

// PUT /api/admin/wines/:id - Update wine definition
router.put('/:id', async (req, res) => {
  try {
    const { name, producer, country, region, appellation, grapes, type, image } = req.body;

    const wine = await WineDefinition.findById(req.params.id);
    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    // Update fields
    if (name) wine.name = name.trim();
    if (producer) wine.producer = producer.trim();
    if (country) wine.country = country;
    if (region !== undefined) wine.region = region || null;
    if (appellation !== undefined) wine.appellation = appellation?.trim();
    if (grapes !== undefined) wine.grapes = grapes;
    if (type) wine.type = type;
    if (image !== undefined) wine.image = image || null;

    // Regenerate normalized key if name, producer, or appellation changed
    if (name || producer || appellation !== undefined) {
      wine.normalizedKey = generateWineKey(
        wine.name,
        wine.producer,
        wine.appellation
      );
    }

    await wine.save();
    await wine.populate(['country', 'region', 'grapes']);

    // Sync to search index (fire-and-forget)
    searchService.indexWine(wine._id);

    logAudit(req, 'admin.wine.update',
      { type: 'wine', id: wine._id },
      { fields: Object.keys(req.body) }
    );

    res.json({ wine });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        error: 'Wine already exists with this name, producer, and appellation combination'
      });
    }
    console.error('Update wine error:', error);
    res.status(500).json({ error: 'Failed to update wine' });
  }
});

// DELETE /api/admin/wines/:id - Delete wine definition
router.delete('/:id', async (req, res) => {
  try {
    const wine = await WineDefinition.findById(req.params.id);
    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    // Check if any bottles reference this wine
    const bottleCount = await Bottle.countDocuments({ wineDefinition: req.params.id });
    if (bottleCount > 0) {
      return res.status(400).json({
        error: `Cannot delete wine. ${bottleCount} bottle(s) reference it.`
      });
    }

    logAudit(req, 'admin.wine.delete',
      { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer }
    );

    await wine.deleteOne();

    // Remove from search index (fire-and-forget)
    searchService.removeWine(req.params.id);

    res.json({ message: 'Wine deleted successfully' });
  } catch (error) {
    console.error('Delete wine error:', error);
    res.status(500).json({ error: 'Failed to delete wine' });
  }
});

module.exports = router;
