const express = require('express');
const WineDefinition = require('../models/WineDefinition');
const searchService = require('../services/search');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const USER_SEARCH_LIMIT = 10;

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

// GET /api/wines - Search/list wines (auth required)
// Regular users: search term mandatory, results capped at USER_SEARCH_LIMIT.
// Admin / somm: full browse and unlimited results.
router.get('/', requireAuth, async (req, res) => {
  try {
    const isPrivileged = req.user.roles.includes('admin') || req.user.roles.includes('somm');

    const {
      country,
      region,
      grapes,
      type,
      search,
      limit = isPrivileged ? 50 : USER_SEARCH_LIMIT,
      offset = 0,
      sort = 'name'
    } = req.query;

    if (!isPrivileged && !search) {
      return res.status(400).json({ error: 'A search term is required' });
    }

    const parsedLimit = isPrivileged
      ? parseInt(limit, 10)
      : Math.min(parseInt(limit, 10) || USER_SEARCH_LIMIT, USER_SEARCH_LIMIT);
    const parsedOffset = parseInt(offset, 10);
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

// POST /api/wines/scan-label - Extract wine name from a label photo using Claude vision
// Body: { image: base64String, mediaType?: "image/jpeg" | "image/png" | "image/webp" }
// Returns: { query: "wine name producer" }
router.post('/scan-label', requireAuth, async (req, res) => {
  const { image, mediaType = 'image/jpeg' } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'Image is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Label scan is not configured on this server' });
  }

  const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({ error: 'Unsupported image type' });
  }

  try {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.default ?? sdk;
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: image }
          },
          {
            type: 'text',
            text: 'Look at this wine bottle label. Extract the wine name and producer. Return ONLY a short search string like "wine name producer" with no explanation, punctuation, or extra words — just the key identifying text from the label.'
          }
        ]
      }]
    });

    const query = (response.content[0]?.text ?? '').trim();
    if (!query) {
      return res.status(422).json({ error: 'Could not read label' });
    }

    res.json({ query });
  } catch (err) {
    console.error('Label scan error:', err.message);
    res.status(500).json({ error: 'Label scan failed' });
  }
});

// GET /api/wines/:id - Get single wine definition (auth required)
router.get('/:id', requireAuth, async (req, res) => {
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
