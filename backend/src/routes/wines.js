const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const searchService = require('../services/search');
const { requireAuth } = require('../middleware/auth');
const { scanLabelFull, identifyWineFromQuery } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { generateWineKey, combinedSimilarity } = require('../utils/normalize');
const { PROCESSED_DIR } = require('../config/upload');
const { parsePagination } = require('../utils/pagination');
const { submitUrls } = require('../services/indexNow');

const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';

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

    const { country, region, grapes, type, search, sort = 'name' } = req.query;

    // Coerce search to string (query params can be arrays if repeated)
    const searchTerm = Array.isArray(search) ? search[0] : search;

    if (!isPrivileged && !searchTerm) {
      return res.status(400).json({ error: 'A search term is required' });
    }
    if (searchTerm && searchTerm.length > 200) {
      return res.status(400).json({ error: 'Search query is too long (max 200 characters)' });
    }

    const paginationOpts = isPrivileged
      ? { limit: 50, maxLimit: 10000 }
      : { limit: USER_SEARCH_LIMIT, maxLimit: USER_SEARCH_LIMIT };
    const { limit: parsedLimit, offset: parsedOffset } = parsePagination(req.query, paginationOpts);
    const grapeIds = grapes ? String(grapes).split(',').filter(id => mongoose.isValidObjectId(id)) : [];

    // Build MongoDB filter (used for non-search queries and as fallback)
    const filter = {};
    if (country) filter.country = mongoose.isValidObjectId(String(country)) ? String(country) : undefined;
    if (region) filter.region = mongoose.isValidObjectId(String(region)) ? String(region) : undefined;
    if (type) filter.type = String(type);
    if (grapeIds.length > 0) filter.grapes = { $in: grapeIds };

    // Try Meilisearch for text queries
    if (searchTerm && searchService.getIsAvailable()) {
      try {
        const { ids, estimatedTotalHits } = await searchService.search(searchTerm, {
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
    const { wines, total } = await mongoSearch(filter, sort, parsedLimit, parsedOffset, searchTerm);

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

// POST /api/wines/scan-label
// Scans a bottle label with Claude vision and returns structured wine data
// plus any existing registry match (for user confirmation before committing).
//
// Body:  { image: base64String, mediaType?: "image/jpeg" | "image/png" | "image/webp" }
// Returns: {
//   extracted: { name, producer, vintage, country, region, appellation, type, grapes[] },
//   match: { wine: WineDefinition, confidence: number } | null,
//   labelImage: "data:image/png;base64,..." (background-removed label, or original as fallback)
// }
router.post('/scan-label', requireAuth, async (req, res) => {
  const { image, mediaType = 'image/jpeg' } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'Image is required' });
  }

  try {
    // 1. Attempt background removal via rembg (non-fatal — falls back to original)
    let scanImage = image;
    let scanMediaType = mediaType;
    let labelImage = `data:${mediaType};base64,${image}`;

    try {
      const buf = Buffer.from(image, 'base64');
      const fd = new FormData();
      fd.append('image', new Blob([buf], { type: mediaType }), 'label.jpg');
      const rembgRes = await fetch(`${REMBG_URL}/remove-bg`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(30000)
      });
      if (rembgRes.ok) {
        const resultBuf = Buffer.from(await rembgRes.arrayBuffer());
        const resultB64 = resultBuf.toString('base64');
        scanImage = resultB64;
        scanMediaType = 'image/png';
        labelImage = `data:image/png;base64,${resultB64}`;
      }
    } catch (rembgErr) {
      console.warn('rembg unavailable for label scan, using original:', rembgErr.message);
    }

    // 2. Extract wine info via Claude
    const extracted = await scanLabelFull(scanImage, scanMediaType);

    // Try to find an existing match in the registry
    let match = null;

    if (extracted.name && extracted.producer) {
      // 1. Exact normalizedKey match
      const normalizedKey = generateWineKey(extracted.name, extracted.producer, extracted.appellation);
      let wine = await WineDefinition.findOne({ normalizedKey })
        .populate(['country', 'region', 'grapes']);

      if (wine) {
        match = { wine, confidence: 1.0 };
      } else {
        // 2. Fuzzy search
        const searchQuery = `${extracted.name} ${extracted.producer}`.trim();
        let candidates = [];

        if (searchService.getIsAvailable()) {
          try {
            const { ids } = await searchService.search(searchQuery, { limit: 20 });
            if (ids.length > 0) {
              candidates = await WineDefinition.find({ _id: { $in: ids } })
                .populate(['country', 'region', 'grapes']);
            }
          } catch (err) {
            console.warn('Meilisearch unavailable during scan-label match:', err.message);
          }
        }

        if (candidates.length === 0) {
          try {
            candidates = await WineDefinition.find({ $text: { $search: searchQuery } })
              .populate(['country', 'region', 'grapes'])
              .limit(20);
          } catch {
            // No text match — no candidates
          }
        }

        let bestMatch = null;
        let bestScore = 0;
        for (const candidate of candidates) {
          const nameSim = combinedSimilarity(extracted.name, candidate.name);
          const prodSim = combinedSimilarity(extracted.producer, candidate.producer);
          let appSim = 1.0;
          if (extracted.appellation && candidate.appellation) {
            appSim = combinedSimilarity(extracted.appellation, candidate.appellation);
          } else if (extracted.appellation || candidate.appellation) {
            appSim = 0.5;
          }
          const score = nameSim * 0.45 + prodSim * 0.45 + appSim * 0.10;
          if (score > bestScore) { bestScore = score; bestMatch = candidate; }
        }

        if (bestScore >= 0.75 && bestMatch) {
          match = { wine: bestMatch, confidence: Math.round(bestScore * 100) / 100 };
        }
      }
    }

    res.json({ extracted, match, labelImage });
  } catch (err) {
    console.error('Label scan error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Label scan failed' });
  }
});

// POST /api/wines/find-or-create
// Called after the user confirms (and optionally edits) the AI-extracted wine data.
// Finds an existing matching wine or creates a new one, including any needed
// taxonomy records (country, region, grapes).
//
// Body:  { name, producer, country, region?, appellation?, type?, grapes?: string[],
//           labelImage?: "data:image/png;base64,..." }
// Returns: { wine: WineDefinition, created: boolean }
router.post('/find-or-create', requireAuth, async (req, res) => {
  const { name, producer, country, region, appellation, type, grapes, labelImage } = req.body;

  if (!name?.trim() || !producer?.trim()) {
    return res.status(400).json({ error: 'name and producer are required' });
  }
  if (!country?.trim()) {
    return res.status(400).json({ error: 'country is required' });
  }

  try {
    const { wine, created } = await findOrCreateWine(
      { name, producer, country, region, appellation, type, grapes: grapes || [] },
      req.user.id
    );

    // Save label image as wine's registry image if:
    //   - a labelImage was provided, AND
    //   - the wine has no image yet (don't overwrite an existing one)
    if (labelImage && !wine.image) {
      try {
        // labelImage is a data URL: "data:<type>;base64,<data>"
        const matches = labelImage.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1] === 'image/png' ? '.png' : '.jpg';
          const buf = Buffer.from(matches[2], 'base64');
          const filename = `wine-label-${wine._id}-${Date.now()}${ext}`;
          const filepath = path.join(PROCESSED_DIR, filename);
          fs.writeFileSync(filepath, buf);
          wine.image = `/api/uploads/processed/${filename}`;
          await WineDefinition.findByIdAndUpdate(wine._id, { image: wine.image });
          searchService.indexWine(wine._id); // keep search index in sync
        }
      } catch (imgErr) {
        console.warn('Failed to save wine label image:', imgErr.message);
      }
    }

    if (created) submitUrls(`/wines/${wine._id}`);

    res.status(created ? 201 : 200).json({ wine, created });
  } catch (err) {
    console.error('Find or create wine error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to find or create wine' });
  }
});

// POST /api/wines/identify-text — identify a wine from a free-text query using AI,
// then find or create it in the registry. Used by the AddBottle manual search fallback.
router.post('/identify-text', requireAuth, async (req, res) => {
  const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    const result = await identifyWineFromQuery(query);
    if (!result.data) {
      return res.json({ wine: null, reason: result.debugReason });
    }

    const { wine, created } = await findOrCreateWine(result.data, req.user.id);
    return res.json({ wine: wine.toObject ? wine.toObject() : wine, created });
  } catch (err) {
    console.error('Identify text error:', err);
    return res.status(500).json({ error: err.message || 'Failed to identify wine' });
  }
});

// POST /api/wines/ai-info — query AI for wine info without creating anything in DB.
// Returns raw AI-identified data (country/region/grapes as name strings, not IDs).
// Used by the AdminRequests page to pre-fill the Create New Wine form.
router.post('/ai-info', requireAuth, async (req, res) => {
  const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query is required' });

  try {
    const result = await identifyWineFromQuery(query);
    if (!result.data) {
      return res.json({ wine: null, reason: result.debugReason });
    }
    return res.json({ wine: result.data });
  } catch (err) {
    console.error('AI info error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get AI wine info' });
  }
});

// GET /api/wines/:id - Get single wine definition (auth required)
// GET /api/wines/:id/public — Public wine detail (no auth required)
// Used for shared links and social media previews.
router.get('/:id/public', async (req, res) => {
  try {
    const wine = await WineDefinition.findById(req.params.id)
      .populate(['country', 'region', 'grapes'])
      .select('name producer country region appellation grapes type image communityRating classification');

    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    res.json({ wine });
  } catch (error) {
    console.error('Get public wine error:', error);
    res.status(500).json({ error: 'Failed to get wine' });
  }
});

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
