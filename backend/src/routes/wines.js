const express = require('express');
const WineDefinition = require('../models/WineDefinition');
const searchService = require('../services/search');

const router = express.Router();

// MongoDB fallback search (used when Meilisearch is unavailable)
async function mongoSearch(filter, sort, limit, offset, search) {
  const sortOptions = {};
  const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
  const sortDir = sort.startsWith('-') ? -1 : 1;

  switch (sortField) {
    case 'name': sortOptions.name = sortDir; break;
    case 'producer': sortOptions.producer = sortDir; break;
    case 'type': sortOptions.type = sortDir; sortOptions.name = 1; break;
    case 'createdAt': case 'created': sortOptions.createdAt = sortDir; break;
    case 'updatedAt': case 'updated': sortOptions.updatedAt = sortDir; break;
    default: sortOptions.name = 1;
  }

  if (search) {
    filter.$text = { $search: search };
    sortOptions.score = { $meta: 'textScore' };
  }

  const query = WineDefinition.find(filter);
  if (search) {
    query.select({ score: { $meta: 'textScore' } });
  }

  const wines = await query
    .populate(['country', 'region', 'grapes'])
    .limit(limit)
    .skip(offset)
    .sort(sortOptions);

  const total = await WineDefinition.countDocuments(filter);
  return { wines, total };
}

// GET /api/wines - Search/list wines (public, no auth required)
router.get('/', async (req, res) => {
  try {
    const {
      country,
      region,
      grapes,
      type,
      search,
      limit = 50,
      offset = 0,
      sort = 'name'
    } = req.query;

    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);
    const grapeIds = grapes ? grapes.split(',') : [];

    // Build MongoDB filter (used for non-search queries and as fallback)
    const filter = {};
    if (country) filter.country = country;
    if (region) filter.region = region;
    if (type) filter.type = type;
    if (grapeIds.length > 0) filter.grapes = { $in: grapeIds };

    // Try Meilisearch for text queries
    if (search && searchService.getIsAvailable()) {
      try {
        const { ids, estimatedTotalHits } = await searchService.search(search, {
          countryId: country,
          regionId: region,
          type,
          grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
          limit: parsedLimit,
          offset: parsedOffset,
          sort
        });

        // Fetch full documents from MongoDB, preserving Meilisearch ranking
        const wines = await WineDefinition.find({ _id: { $in: ids } })
          .populate(['country', 'region', 'grapes']);

        // Re-order to match Meilisearch relevance ranking
        const idOrder = new Map(ids.map((id, i) => [id, i]));
        wines.sort((a, b) => idOrder.get(a._id.toString()) - idOrder.get(b._id.toString()));

        return res.json({
          count: wines.length,
          total: estimatedTotalHits,
          offset: parsedOffset,
          limit: parsedLimit,
          wines
        });
      } catch (err) {
        console.warn('Meilisearch query failed, falling back to MongoDB:', err.message);
      }
    }

    // MongoDB path: no search term, or Meilisearch unavailable/failed
    const { wines, total } = await mongoSearch(filter, sort, parsedLimit, parsedOffset, search);

    res.json({
      count: wines.length,
      total,
      offset: parsedOffset,
      limit: parsedLimit,
      wines
    });
  } catch (error) {
    console.error('Get wines error:', error);
    res.status(500).json({ error: 'Failed to get wines' });
  }
});

// GET /api/wines/:id - Get single wine definition
router.get('/:id', async (req, res) => {
  try {
    const wine = await WineDefinition.findById(req.params.id)
      .populate(['country', 'region', 'grapes']);

    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    res.json({ wine });
  } catch (error) {
    console.error('Get wine error:', error);
    res.status(500).json({ error: 'Failed to get wine' });
  }
});

module.exports = router;
