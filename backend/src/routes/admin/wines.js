const express = require('express');
const mongoose = require('mongoose');
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
const BottleImage = require('../../models/BottleImage');
const WineVintageProfile = require('../../models/WineVintageProfile');
const WineVintagePrice = require('../../models/WineVintagePrice');
const WineReport = require('../../models/WineReport');
const Review = require('../../models/Review');
const Discussion = require('../../models/Discussion');
const DiscussionReply = require('../../models/DiscussionReply');
const WineEmbedding = require('../../models/WineEmbedding');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');

// Escape special regex characters to prevent ReDoS / NoSQL injection
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wines - List wine definitions
router.get('/', async (req, res) => {
  try {
    const { search, type, sort, page = 1, limit = 50 } = req.query;
    const parsedLimit = parseInt(limit);
    const parsedPage = parseInt(page);
    const skip = (parsedPage - 1) * parsedLimit;

    const sortMap = {
      'name': { name: 1 },
      '-name': { name: -1 },
      'producer': { producer: 1 },
      '-createdAt': { createdAt: -1 }
    };
    const sortObj = sortMap[sort] || { name: 1 };

    // Try Meilisearch for text queries (fuzzy, searches name/producer/appellation/region/country/grapes)
    if (search && searchService.getIsAvailable()) {
      try {
        const { ids, estimatedTotalHits } = await searchService.search(search, {
          type: type || undefined,
          limit: parsedLimit,
          offset: skip,
          sort: sort && sort !== 'name' ? sort : undefined
        });

        const wines = await WineDefinition.find({ _id: { $in: ids } })
          .populate('country', 'name')
          .populate('region', 'name')
          .populate('grapes', 'name');

        // Preserve Meilisearch relevance order
        const idOrder = new Map(ids.map((id, i) => [id, i]));
        wines.sort((a, b) => idOrder.get(a._id.toString()) - idOrder.get(b._id.toString()));

        return res.json({
          wines,
          total: estimatedTotalHits,
          page: parsedPage,
          pages: Math.ceil(estimatedTotalHits / parsedLimit)
        });
      } catch (err) {
        console.warn('Meilisearch unavailable, falling back to MongoDB:', err.message);
      }
    }

    // MongoDB fallback: $text index when searching (name + producer), regex otherwise
    const conditions = [];
    if (search) {
      conditions.push({ $text: { $search: search } });
    }
    if (type) {
      conditions.push({ type });
    }
    const query = conditions.length === 0 ? {}
      : conditions.length === 1 ? conditions[0]
      : { $and: conditions };

    // When using $text, sort by relevance score first
    const mongoSort = search ? { score: { $meta: 'textScore' }, ...sortObj } : sortObj;

    const [wines, total] = await Promise.all([
      WineDefinition.find(query)
        .select(search ? { score: { $meta: 'textScore' } } : {})
        .populate('country', 'name')
        .populate('region', 'name')
        .populate('grapes', 'name')
        .sort(mongoSort)
        .skip(skip)
        .limit(parsedLimit),
      WineDefinition.countDocuments(query)
    ]);

    res.json({
      wines,
      total,
      page: parsedPage,
      pages: Math.ceil(total / parsedLimit)
    });
  } catch (error) {
    console.error('List wines error:', error);
    res.status(500).json({ error: 'Failed to list wines' });
  }
});

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

    submitUrls(`/wines/${wine._id}`);

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
        { name: new RegExp(escapeRegex(name.split(' ')[0]), 'i') },
        { producer: new RegExp(escapeRegex(producer.split(' ')[0]), 'i') }
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

// GET /api/admin/wines/:id - Get single wine definition
router.get('/:id', async (req, res) => {
  try {
    const wine = await WineDefinition.findById(req.params.id)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name');
    if (!wine) return res.status(404).json({ error: 'Wine not found' });
    res.json({ wine });
  } catch (error) {
    console.error('Get wine error:', error);
    res.status(500).json({ error: 'Failed to get wine' });
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

    submitUrls(`/wines/${wine._id}`);

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
        error: `Cannot delete wine. ${bottleCount} bottle(s) reference it.`,
        bottleCount
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

// POST /api/admin/wines/:id/merge - Merge source wine into target, reassign all references, then delete source
router.post('/:id/merge', async (req, res) => {
  try {
    const { targetId } = req.body;
    const sourceId = req.params.id;

    if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ error: 'A valid targetId is required' });
    }
    if (sourceId === targetId) {
      return res.status(400).json({ error: 'Cannot merge a wine into itself' });
    }

    const [source, target] = await Promise.all([
      WineDefinition.findById(sourceId),
      WineDefinition.findById(targetId),
    ]);
    if (!source) return res.status(404).json({ error: 'Source wine not found' });
    if (!target) return res.status(404).json({ error: 'Target wine not found' });

    // Reassign all references from source to target

    const results = await Promise.all([
      Bottle.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ),
      BottleImage.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ),
      WineVintageProfile.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ),
      WineVintagePrice.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ),
      WineReport.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ),
      // Reviews have a unique index on (author, wineDefinition) — skip duplicates
      Review.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ).catch(() => {
        // If unique constraint conflicts, delete the source reviews instead
        return Review.deleteMany({ wineDefinition: sourceId });
      }),
    ]);

    await Promise.all([
      Discussion.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ),
      DiscussionReply.updateMany(
        { wineDefinition: sourceId },
        { $set: { wineDefinition: targetId } }
      ),
      WineEmbedding.deleteMany({ wineDefinition: sourceId }),
    ]);

    const bottlesMoved = results[0].modifiedCount || 0;

    logAudit(req, 'admin.wine.merge',
      { type: 'wine', id: source._id },
      {
        sourceName: source.name,
        sourceProducer: source.producer,
        targetId: target._id,
        targetName: target.name,
        targetProducer: target.producer,
        bottlesMoved,
      }
    );

    await source.deleteOne();
    searchService.removeWine(sourceId);

    res.json({
      message: 'Wines merged successfully',
      bottlesMoved,
    });
  } catch (error) {
    console.error('Merge wine error:', error);
    res.status(500).json({ error: 'Failed to merge wines' });
  }
});

module.exports = router;
