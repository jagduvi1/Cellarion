const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const {
  generateWineKey,
  calculateSimilarity,
  combinedSimilarity,
  trigramSimilarity,
  tokenSimilarity,
  normalizeString,
  normalizeProducerKey,
  normalizeAppellation
} = require('../../utils/normalize');
const { scoreWineMatch } = require('../../services/wineMatching');
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
const WineNotDuplicate = require('../../models/WineNotDuplicate');
const WineList = require('../../models/WineList');
const WishlistItem = require('../../models/WishlistItem');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../../models/PriceTrackingSkip');
const CommunityWinePrice = require('../../models/CommunityWinePrice');
const JournalEntry = require('../../models/JournalEntry');
const Recommendation = require('../../models/Recommendation');
const RestockAlert = require('../../models/RestockAlert');
const WineRequest = require('../../models/WineRequest');
const vectorStore = require('../../services/vectorStore');
const { unlinkImageFiles } = require('../../services/imageProcessor');
const { embedSinglePair } = require('../../services/embeddingJob');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const { isValidId } = require('../../utils/validation');
const { escapeRegex } = require('../../utils/sanitize');
const { parsePagination } = require('../../utils/pagination');
const { stripProducerName } = require('../../utils/producerPrefix');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wines - List wine definitions
router.get('/', async (req, res) => {
  try {
    const { search, type, sort } = req.query;
    const { limit: parsedLimit, offset: skip, page: parsedPage } =
      parsePagination(req.query, { limit: 50, maxLimit: 200 });

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
      appellation: normalizeAppellation(appellation?.trim()),
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

// POST /api/admin/wines/:id/image - set the wine's OFFICIAL image (pre-approved,
// public, replaces any prior official image) from an https URL or base64 bytes,
// with an optional credit/attribution. Shares ONE implementation with the MCP
// admin_add_registry_wine tool (services/imageOps.attachOfficialWineImage);
// bytes from a URL go through the same SSRF guard as the MCP attach tool.
router.post('/:id/image', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid wine ID' });
    }
    const wine = await WineDefinition.findById(req.params.id).select('_id name producer');
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    const { image_url: imageUrl, image_base64: imageBase64, credit } = req.body || {};
    if (!imageUrl && !imageBase64) {
      return res.status(400).json({ error: 'Provide image_url (https) or image_base64' });
    }
    if (imageUrl && imageBase64) {
      return res.status(400).json({ error: 'Provide image_url OR image_base64, not both' });
    }
    if (credit && (typeof credit !== 'string' || credit.length > 200)) {
      return res.status(400).json({ error: 'credit must be a string of at most 200 characters' });
    }

    let buffer;
    if (imageUrl) {
      const { safeFetchImage } = require('../../utils/safeImageFetch');
      try {
        buffer = (await safeFetchImage(String(imageUrl))).buffer;
      } catch (err) {
        return res.status(400).json({ error: `Could not fetch that image: ${err.message}` });
      }
    } else {
      const b64 = String(imageBase64).replace(/^data:image\/[a-z+]+;base64,/i, '');
      buffer = Buffer.from(b64, 'base64');
      if (buffer.length === 0) return res.status(400).json({ error: 'image_base64 did not decode to any bytes' });
    }

    const { attachOfficialWineImage } = require('../../services/imageOps');
    const result = await attachOfficialWineImage(
      { buffer, wineDefinitionId: wine._id, credit: credit ? String(credit).trim() : null, userId: req.user.id },
      req
    );
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });

    logAudit(req, 'admin.wine.image.set',
      { type: 'wine', id: wine._id },
      { imageId: String(result.image._id), credit: credit || null });

    res.status(201).json({ image: result.image });
  } catch (error) {
    console.error('Set wine image error:', error);
    res.status(500).json({ error: 'Failed to set the wine image' });
  }
});

// GET /api/admin/wines/duplicates - Find potential duplicates
// GET /api/admin/wines/duplicate-clusters
//
// Registry-wide scan: groups wines by normalised producer (cheap O(N) bucket),
// then runs pairwise scoring inside each bucket. Any pair scoring >= minScore
// becomes an edge; connected components form clusters.
//
// Producer grouping is the pragmatic pre-filter: real duplicates almost always
// share a producer (people typo the wine name, not the producer). Cases where
// the producer itself is typo'd are missed by this scan — a future producer-
// dedup pass is the right fix there.
//
// Query: minScore (default 0.6), limit (default 50, max 200)
// Returns: { clusters: [{ score, wines: [{ wine, bottleCount }] }], scannedCount }
router.get('/duplicate-clusters', async (req, res) => {
  try {
    const minScore = Math.max(0, Math.min(1, parseFloat(req.query.minScore) || 0.6));
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));

    // Fetch every wine — small projection so we don't pull the world.
    // Sort by producer so we can stream-group instead of building a large map.
    const wines = await WineDefinition.find({})
      .select('name producer appellation image type country region')
      .populate('country', 'name')
      .populate('region', 'name')
      .lean();

    // Group by normalised producer KEY: wine stop words + corporate suffixes
    // stripped, so "Kumeu River Wines Limited" and "Kumeu River" land in the
    // same bucket and the pairwise scorer + merge UI can surface them (ticket
    // #2B). Bucketing only ever MERGES buckets (fewer distinct keys), never
    // splits, so existing clusters can't regress; every surfaced cluster is
    // admin-reviewed before any merge, so over-grouping is safe.
    const byProducer = new Map();
    for (const wine of wines) {
      const key = normalizeProducerKey(wine.producer || '');
      if (!key) continue;
      let group = byProducer.get(key);
      if (!group) { group = []; byProducer.set(key, group); }
      group.push(wine);
    }

    // Union-find over wine _ids
    const parent = new Map();
    const find = (id) => {
      let p = parent.get(id);
      if (p === id) return id;
      p = find(p);
      parent.set(id, p);
      return p;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    // Pairs an admin has confirmed are NOT the same wine — skip these edges so
    // they stop resurfacing on every scan. Keyed canonically as "smaller|larger".
    const notDup = await WineNotDuplicate.find({}).select('wineA wineB').lean();
    const dismissed = new Set(notDup.map(d => `${d.wineA}|${d.wineB}`));

    // Score pairs within each producer group
    const edgeScore = new Map(); // "a|b" -> best score (so we can keep cluster score later)
    for (const group of byProducer.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        const a = group[i];
        const aId = String(a._id);
        if (!parent.has(aId)) parent.set(aId, aId);
        for (let j = i + 1; j < group.length; j++) {
          const b = group[j];
          const bId = String(b._id);
          if (!parent.has(bId)) parent.set(bId, bId);
          const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
          if (dismissed.has(key)) continue; // admin marked these as not duplicates
          const score = scoreWineMatch(
            { name: a.name, producer: a.producer, appellation: a.appellation },
            { name: b.name, producer: b.producer, appellation: b.appellation },
            { redistribute: false }
          );
          if (score >= minScore) {
            union(aId, bId);
            edgeScore.set(key, score);
          }
        }
      }
    }

    // Bucket wines by cluster root
    const clusters = new Map();
    for (const id of parent.keys()) {
      const root = find(id);
      let bucket = clusters.get(root);
      if (!bucket) { bucket = { wineIds: [], score: 0 }; clusters.set(root, bucket); }
      bucket.wineIds.push(id);
    }

    // Drop singletons (a wine in its own cluster isn't a duplicate)
    // Compute cluster score = max pairwise score among any edge in the cluster
    const wineById = new Map(wines.map(w => [String(w._id), w]));
    const result = [];
    for (const [, bucket] of clusters) {
      if (bucket.wineIds.length < 2) continue;
      let best = 0;
      for (let i = 0; i < bucket.wineIds.length; i++) {
        for (let j = i + 1; j < bucket.wineIds.length; j++) {
          const a = bucket.wineIds[i], b = bucket.wineIds[j];
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          const s = edgeScore.get(key) || 0;
          if (s > best) best = s;
        }
      }
      result.push({
        score: Math.round(best * 100) / 100,
        wineIds: bucket.wineIds,
      });
    }

    // Sort clusters by best score desc and trim
    result.sort((a, b) => b.score - a.score);
    const trimmed = result.slice(0, limit);

    // Look up bottle counts in one aggregate
    const allClusterWineIds = trimmed.flatMap(c => c.wineIds);
    const bottleCounts = new Map();
    if (allClusterWineIds.length > 0) {
      const counts = await Bottle.aggregate([
        { $match: { wineDefinition: { $in: allClusterWineIds.map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
      ]);
      for (const c of counts) bottleCounts.set(String(c._id), c.count);
    }

    res.json({
      scannedCount: wines.length,
      producerGroupCount: byProducer.size,
      totalClusters: result.length,
      clusters: trimmed.map(c => ({
        score: c.score,
        wines: c.wineIds.map(id => {
          const w = wineById.get(id);
          return { ...w, bottleCount: bottleCounts.get(id) || 0 };
        }),
      })),
    });
  } catch (err) {
    console.error('Duplicate cluster scan error:', err);
    res.status(500).json({ error: 'Failed to scan for duplicates' });
  }
});

// All canonical unordered pairs (wineA < wineB by hex) from a set of wine ids,
// as ObjectIds — used to record / remove "not duplicate" decisions.
function buildWinePairs(ids) {
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      pairs.push({ wineA: new mongoose.Types.ObjectId(a), wineB: new mongoose.Types.ObjectId(b) });
    }
  }
  return pairs;
}

// POST /api/admin/wines/dismiss-duplicates — mark a cluster's wines as NOT the
// same wine. Records every pair so the duplicate scanner stops surfacing them.
// Body: { wineIds: [id, id, ...] } (the cluster's wine ids)
router.post('/dismiss-duplicates', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 2) {
      return res.status(400).json({ error: 'wineIds must contain at least 2 valid, distinct ids' });
    }
    const pairs = buildWinePairs(ids);
    await WineNotDuplicate.bulkWrite(
      pairs.map(p => ({
        updateOne: {
          filter: { wineA: p.wineA, wineB: p.wineB },
          update: { $setOnInsert: { wineA: p.wineA, wineB: p.wineB } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    logAudit(req, 'admin.wine.dismissDuplicates', { type: 'wine', id: ids[0] }, { wineIds: ids, pairs: pairs.length });
    res.json({ message: 'Marked as not duplicates', pairsRecorded: pairs.length });
  } catch (error) {
    console.error('Dismiss duplicates error:', error);
    res.status(500).json({ error: 'Failed to mark as not duplicates' });
  }
});

// DELETE /api/admin/wines/dismiss-duplicates — undo the above for a cluster.
// Body: { wineIds: [id, id, ...] }
router.delete('/dismiss-duplicates', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 2) {
      return res.status(400).json({ error: 'wineIds must contain at least 2 valid, distinct ids' });
    }
    const result = await WineNotDuplicate.deleteMany({ $or: buildWinePairs(ids) });
    logAudit(req, 'admin.wine.undismissDuplicates', { type: 'wine', id: ids[0] }, { wineIds: ids });
    res.json({ message: 'Restored', pairsRemoved: result.deletedCount || 0 });
  } catch (error) {
    console.error('Undismiss duplicates error:', error);
    res.status(500).json({ error: 'Failed to restore' });
  }
});

router.get('/duplicates', async (req, res) => {
  try {
    const { name, producer, appellation, threshold = 0.75 } = req.query;

    if (!name || !producer) {
      return res.status(400).json({ error: 'Name and producer are required' });
    }

    // Candidate gathering. MongoDB rejects $text inside $or unless every
    // other $or clause is indexed (TEXT-under-OR planner restriction), and
    // name/producer have no B-tree indexes — so run the text search and the
    // regex fallback as two separate queries and merge the candidates.
    const searchTerms = `${name} ${producer}`.trim();
    const CANDIDATE_LIMIT = 200;
    const [textHits, regexHits] = await Promise.all([
      WineDefinition.find({ $text: { $search: searchTerms } })
        .populate(['country', 'region', 'grapes'])
        .limit(CANDIDATE_LIMIT),
      WineDefinition.find({
        $or: [
          { name: new RegExp(escapeRegex(name.split(' ')[0]), 'i') },
          { producer: new RegExp(escapeRegex(producer.split(' ')[0]), 'i') }
        ]
      })
        .populate(['country', 'region', 'grapes'])
        .limit(CANDIDATE_LIMIT)
    ]);

    const seenIds = new Set();
    const allWines = [];
    for (const wine of [...textHits, ...regexHits]) {
      const key = wine._id.toString();
      if (!seenIds.has(key)) {
        seenIds.add(key);
        allWines.push(wine);
      }
      if (allWines.length >= CANDIDATE_LIMIT) break;
    }

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

// GET /api/admin/wines/producer-in-name — wines whose name STARTS or ENDS
// with their own producer (prefix: producer "Meerlust", name "Meerlust
// Chardonnay"; suffix: producer "Mastroberardino", name "Fiano di Avellino
// Mastroberardino" — the launch-day admin report). Mostly AI-import
// artefacts; the registry convention is a producer-free name.
//
// A field-to-field comparison needs $expr; there's no index for it, so this
// is a collection scan — fine at the registry's ~3k-doc size. The char right
// AFTER a prefix / BEFORE a suffix must be a separator so producer "Chateau"
// doesn't flag "Chateauneuf-du-Pape" (mirrors utils/producerPrefix.js).
//
// Returns: { wines: [{ _id, producer, name, proposedName, bottleCount, createdAt }], total, page, pages }
router.get('/producer-in-name', async (req, res) => {
  try {
    const { limit: parsedLimit, offset: skip, page: parsedPage } =
      parsePagination(req.query, { limit: 50, maxLimit: 200 });

    const producerLen = { $strLenCP: { $ifNull: ['$producer', ''] } };
    const nameLen = { $strLenCP: '$name' };
    const lowerProducer = { $toLower: { $ifNull: ['$producer', ''] } };
    const SEPARATORS = [' ', '\t', '-', '–', '—'];
    const common = [
      { $gt: [producerLen, 0] },
      { $gt: [nameLen, { $add: [producerLen, 1] }] },
    ];
    const prefixExpr = {
      $and: [
        ...common,
        { $eq: [{ $indexOfCP: [{ $toLower: '$name' }, lowerProducer] }, 0] },
        { $in: [{ $substrCP: ['$name', producerLen, 1] }, SEPARATORS] },
      ],
    };
    const suffixStart = { $subtract: [nameLen, producerLen] };
    const suffixExpr = {
      $and: [
        ...common,
        { $eq: [{ $toLower: { $substrCP: ['$name', suffixStart, producerLen] } }, lowerProducer] },
        { $in: [{ $substrCP: ['$name', { $subtract: [suffixStart, 1] }, 1] }, SEPARATORS] },
      ],
    };
    const filter = { $expr: { $or: [prefixExpr, suffixExpr] } };

    const [wines, total] = await Promise.all([
      WineDefinition.find(filter)
        .select('name producer createdAt')
        .sort({ producer: 1, name: 1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      WineDefinition.countDocuments(filter),
    ]);

    // Bottle counts for the page's rows in one aggregate
    const bottleCounts = new Map();
    if (wines.length > 0) {
      const counts = await Bottle.aggregate([
        { $match: { wineDefinition: { $in: wines.map(w => w._id) } } },
        { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
      ]);
      for (const c of counts) bottleCounts.set(String(c._id), c.count);
    }

    res.json({
      wines: wines.map(w => ({
        _id: w._id,
        producer: w.producer,
        name: w.name,
        proposedName: stripProducerName(w.name, w.producer),
        bottleCount: bottleCounts.get(String(w._id)) || 0,
        createdAt: w.createdAt,
      })),
      total,
      page: parsedPage,
      pages: Math.ceil(total / parsedLimit),
    });
  } catch (error) {
    console.error('Producer-in-name scan error:', error);
    res.status(500).json({ error: 'Failed to scan for producer-in-name wines' });
  }
});

// GET /api/admin/wines/:id - Get single wine definition
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
    if (appellation !== undefined) wine.appellation = normalizeAppellation(appellation?.trim());
    if (grapes !== undefined) wine.grapes = grapes;
    if (type) wine.type = type;

    // Image handling. When the admin clears the default image, look for an
    // approved+public gallery image to promote in its place — otherwise the
    // wine ends up with no image even though candidates exist (the legacy
    // label-scan URL bug left wines in this state after Remove default image).
    if (image !== undefined) {
      if (image) {
        wine.image = image;
      } else {
        const replacement = await BottleImage.findOne({
          wineDefinition: wine._id,
          status: 'approved',
          visibility: 'public'
        }).sort({ assignedToWine: -1, createdAt: -1 });

        // Clear stale assignedToWine flags so only the new default carries it
        await BottleImage.updateMany(
          { wineDefinition: wine._id, assignedToWine: true },
          { assignedToWine: false }
        );

        if (replacement) {
          replacement.assignedToWine = true;
          await replacement.save();
          wine.image = replacement.processedUrl || replacement.originalUrl;
          wine.imageCredit = replacement.credit || null;
        } else {
          wine.image = null;
          wine.imageCredit = null;
        }
      }
    }

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

    // Sync to search index (fire-and-forget). Bottle documents denormalize
    // wineName/producer/country/region/grape names — without re-indexing
    // them, cellar search keeps matching the old values indefinitely (no
    // scheduled resync exists; full-sync only runs on an empty index).
    searchService.indexWine(wine._id);
    if (name !== undefined || producer !== undefined || country !== undefined ||
        region !== undefined || appellation !== undefined || grapes !== undefined ||
        type !== undefined) {
      Bottle.distinct('_id', { wineDefinition: wine._id })
        .then(ids => searchService.bulkIndexBottles(ids))
        .catch(err => console.error('Bottle re-index after wine update failed:', err.message));
    }

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
//
// Refuses while USER-AUTHORED content references the wine (bottles, wishlist
// items, reviews, discussions/replies, journal pairings, wine-list entries,
// recommendations) — deleting under those would orphan or silently vanish
// other people's data; merge re-points references and is the right tool.
// Registry-side/derived data that only exists FOR the wine (maturity
// profiles, price snapshots/opt-ins, community prices, embeddings + Qdrant
// vectors, restock alerts, reports) is cascade-deleted with it.
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wine = await WineDefinition.findById(req.params.id);
    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }
    const id = wine._id;

    const [bottles, wishlistItems, reviews, discussions, discussionReplies, journalEntries, wineLists, recommendations] = await Promise.all([
      Bottle.countDocuments({ wineDefinition: id }),
      WishlistItem.countDocuments({ wineDefinition: id }),
      Review.countDocuments({ wineDefinition: id }),
      Discussion.countDocuments({ wineDefinition: id }),
      DiscussionReply.countDocuments({ wineDefinition: id }),
      JournalEntry.countDocuments({ 'pairings.wine': id }),
      WineList.countDocuments({ $or: [{ 'sections.entries.wine': id }, { 'autoGroupEntries.wine': id }] }),
      Recommendation.countDocuments({ wine: id }),
    ]);
    const references = { bottles, wishlistItems, reviews, discussions, discussionReplies, journalEntries, wineLists, recommendations };
    const blocking = Object.entries(references).filter(([, n]) => n > 0);
    if (blocking.length > 0) {
      return res.status(400).json({
        error: `Cannot delete wine. User content references it (${blocking.map(([k, n]) => `${n} ${k}`).join(', ')}). Merge it into another wine instead.`,
        references,
        // The admin UI pivots to the merge modal on this field.
        bottleCount: bottles,
      });
    }

    // Cascade the registry-side/derived data. All idempotent deletes — a
    // partial failure leaves the wine in place and the delete re-runnable.
    await Promise.all([
      WineVintageProfile.deleteMany({ wineDefinition: id }),
      WineVintagePrice.deleteMany({ wineDefinition: id }),
      PriceTrackingRequest.deleteMany({ wineDefinition: id }),
      PriceTrackingSkip.deleteMany({ wineDefinition: id }),
      CommunityWinePrice.deleteMany({ wineDefinition: id }),
      RestockAlert.deleteMany({ wine: id }),
      RestockAlert.updateMany({ similarWineIds: id }, { $pull: { similarWineIds: id } }),
      WineReport.deleteMany({ wineDefinition: id }),
      WineReport.updateMany({ duplicateOf: id }, { $unset: { duplicateOf: '' } }),
      WineRequest.updateMany({ linkedWineDefinition: id }, { $unset: { linkedWineDefinition: '' } }),
      WineNotDuplicate.deleteMany({ $or: [{ wineA: id }, { wineB: id }] }),
      // Qdrant points + WineEmbedding bookkeeping rows (same helper as merge).
      purgeSourceVectors(id),
    ]);

    // Registry images assigned to this wine. With zero bottles referencing the
    // wine, an image without a bottle ref has no other home — delete the doc
    // and its disk files (files first: the doc holds the only reference). An
    // image still attached to some bottle just loses the wine assignment.
    const orphanImages = await BottleImage.find({ wineDefinition: id, bottle: null })
      .select('originalUrl processedUrl').lean();
    for (const img of orphanImages) await unlinkImageFiles(img);
    await Promise.all([
      BottleImage.deleteMany({ wineDefinition: id, bottle: null }),
      BottleImage.updateMany({ wineDefinition: id }, { $unset: { wineDefinition: '' }, $set: { assignedToWine: false } }),
    ]);

    logAudit(req, 'admin.wine.delete',
      { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer, imagesDeleted: orphanImages.length }
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

// POST /api/admin/wines/:id/strip-producer — remove the wine's own producer
// (prefix OR suffix) from its name (companion to GET /producer-in-name).
// Recomputes the check server-side so a stale client row can't rename
// arbitrarily.
router.post('/:id/strip-producer', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wine = await WineDefinition.findById(req.params.id);
    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    const stripped = stripProducerName(wine.name, wine.producer);
    if (!stripped) {
      return res.status(400).json({
        error: 'Wine name does not start or end with its producer, or nothing would remain after stripping'
      });
    }

    // If the same producer already has a wine with the stripped name, renaming
    // would create the very duplicate the registry avoids — the admin should
    // resolve that pair via the duplicates tool instead.
    const conflict = await WineDefinition.findOne({
      _id: { $ne: wine._id },
      producer: new RegExp(`^${escapeRegex(wine.producer)}$`, 'i'),
      name: new RegExp(`^${escapeRegex(stripped)}$`, 'i'),
    }).select('name producer');
    if (conflict) {
      return res.status(409).json({
        error: `"${conflict.name}" by ${conflict.producer} already exists — merge these via the duplicates tool instead.`,
        conflictId: conflict._id,
      });
    }

    const from = wine.name;
    wine.name = stripped;
    // Same denormalised-field maintenance as the PUT rename path: regenerate
    // the dedup key; the slug is deliberately NOT regenerated (URL stability).
    wine.normalizedKey = generateWineKey(wine.name, wine.producer, wine.appellation);
    await wine.save();
    await wine.populate(['country', 'region', 'grapes']);

    // Sync to search index (fire-and-forget)
    searchService.indexWine(wine._id);

    logAudit(req, 'admin.wine.strip_producer',
      { type: 'wine', id: wine._id },
      { from, to: wine.name }
    );

    submitUrls(`/wines/${wine._id}`);

    res.json({ wine });
  } catch (error) {
    if (error.code === 11000) {
      // Unique normalizedKey collision the pre-check missed (e.g. differing
      // appellation normalisation) — same guidance as the explicit conflict.
      return res.status(409).json({
        error: 'Another wine already exists with this name, producer, and appellation combination — merge via the duplicates tool instead.'
      });
    }
    console.error('Strip producer error:', error);
    res.status(500).json({ error: 'Failed to strip producer from name' });
  }
});

// POST /api/admin/wines/:id/merge - Merge source wine into target, reassign all references, then delete source
router.post('/:id/merge', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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

    // Capture the source's primary BottleImage (the one whose URL backs
    // WineDefinition.image) BEFORE the bulk reassign below. After reassign
    // it'll point to target, so we need its _id now to decide what to do
    // with the assignedToWine flag.
    const sourcePrimaryImage = await BottleImage.findOne({
      wineDefinition: sourceId,
      assignedToWine: true,
    }).select('_id processedUrl originalUrl');

    // Reassign every reference from source to target (shared with the golden
    // /merge route so both stay in lockstep — one place to add new models).
    const bottlesMoved = await reassignWineRefs(sourceId, targetId);

    // Image consolidation. Contract elsewhere in the codebase (admin/images.js
    // approval flow) is: a wine has at most one BottleImage with
    // assignedToWine: true, and its URL is denormalised into WineDefinition.image.
    // After the bulk reassign above, two things can be broken:
    //   1. Target had no image but source did → target.image still null even
    //      though the source's primary BottleImage is now sitting on target.
    //   2. Target had its own image AND source had a primary image → two
    //      BottleImages now point to target with assignedToWine: true.
    let imageAction = 'none';
    if (sourcePrimaryImage) {
      if (!target.image) {
        // Case 1: adopt the source's primary image as target's
        const sourceUrl = sourcePrimaryImage.processedUrl || sourcePrimaryImage.originalUrl;
        await WineDefinition.findByIdAndUpdate(targetId, {
          image: sourceUrl,
          imageCredit: source.imageCredit || null,
        });
        imageAction = 'adopted_from_source';
      } else {
        // Case 2: target keeps its own image; clear the source's
        // assigned-to-wine flag so we don't have two primaries
        await BottleImage.findByIdAndUpdate(sourcePrimaryImage._id, {
          assignedToWine: false,
        });
        imageAction = 'cleared_source_assignment';
      }
    }

    // Carry the source's AI tasting profile to the keeper if the keeper has none,
    // so the re-embed below encodes taste/style instead of losing it on merge.
    await inheritAiProfileIfMissing(target, [source]);

    logAudit(req, 'admin.wine.merge',
      { type: 'wine', id: source._id },
      {
        sourceName: source.name,
        sourceProducer: source.producer,
        targetId: target._id,
        targetName: target.name,
        targetProducer: target.producer,
        bottlesMoved,
        imageAction,
      }
    );

    await source.deleteOne();
    searchService.removeWine(sourceId);
    // Target was mutated if we adopted the image; re-index so search sees it
    if (imageAction === 'adopted_from_source') searchService.indexWine(targetId);

    // Re-embed the keeper's vintages (it just absorbed the source's bottles and
    // possibly its profile) so semantic search reflects the merged wine.
    reembedKeeper(targetId);

    res.json({
      message: 'Wines merged successfully',
      bottlesMoved,
      imageAction,
    });
  } catch (error) {
    console.error('Merge wine error:', error);
    res.status(500).json({ error: 'Failed to merge wines' });
  }
});

// ── Merge embedding / enrichment consistency helpers ─────────────────────────

// Delete a merged-away source's vectors from BOTH Qdrant and the WineEmbedding
// bookkeeping. Deleting the rows alone would orphan the real vectors in Qdrant
// (and discard the point ids needed to ever target them), so we delete the
// Qdrant points first — grouped by the index version (collection) they live in —
// then drop the rows. Best-effort: a Qdrant hiccup must not fail the merge.
async function purgeSourceVectors(sourceId) {
  try {
    const embs = await WineEmbedding.find({ wineDefinition: sourceId })
      .select('qdrantPointId indexVersion').lean();
    const byIndex = new Map();
    for (const e of embs) {
      if (!e.qdrantPointId) continue;
      if (!byIndex.has(e.indexVersion)) byIndex.set(e.indexVersion, []);
      byIndex.get(e.indexVersion).push(e.qdrantPointId);
    }
    for (const [indexVersion, ids] of byIndex) {
      await vectorStore.deletePoints(indexVersion, ids).catch(() => {});
    }
  } catch (err) {
    console.warn('[merge] purge source vectors failed (%s):', sourceId, err.message);
  }
  await WineEmbedding.deleteMany({ wineDefinition: sourceId });
}

// If the keeper has no AI tasting profile, inherit the best one (highest
// confidence) from the wines being merged in, so the keeper's re-embedding still
// encodes taste/style instead of dropping to identity-only text. Free — no AI
// call. No-op when the keeper is already enriched or no source has a profile.
async function inheritAiProfileIfMissing(keeper, sources) {
  if (keeper.aiProfile?.description) return;
  const donor = sources
    .filter(w => w.aiProfile?.description)
    .sort((a, b) => (b.aiProfile.confidence ?? 0) - (a.aiProfile.confidence ?? 0))[0];
  if (!donor) return;
  const profile = typeof donor.aiProfile.toObject === 'function'
    ? donor.aiProfile.toObject()
    : donor.aiProfile;
  keeper.aiProfile = profile;
  await WineDefinition.updateOne({ _id: keeper._id }, { $set: { aiProfile: profile } });
}

// Re-embed every active vintage the keeper now owns so the vector store reflects
// the merged-in bottles (and any inherited profile). Mirrors the bottle-add hook:
// embedSinglePair is a no-op when the text is unchanged and self-skips while a
// batch embedding job is running. Fire-and-forget; never throws.
async function reembedKeeper(keeperId) {
  try {
    const vintages = await Bottle.distinct('vintage', { wineDefinition: keeperId, status: 'active' });
    for (const v of vintages) {
      await embedSinglePair(keeperId, v).catch(() => {});
    }
  } catch (err) {
    console.warn('[merge] re-embed keeper failed (%s):', keeperId, err.message);
  }
}

// Wine list entries reference WineDefinition directly (wine+vintage+size key),
// so a merge must re-point them or the wine silently vanishes from published
// menus and PDFs. Idempotent like the other reassigns. A list that already had
// an entry for the keeper may end up with two entries for the same wine — the
// owner sees both in the editor and can remove one; vanishing silently is the
// failure mode we must avoid.
function reassignWineListEntries(sourceId, keeperId) {
  return Promise.all([
    WineList.updateMany(
      { 'autoGroupEntries.wine': sourceId },
      { $set: { 'autoGroupEntries.$[e].wine': keeperId } },
      { arrayFilters: [{ 'e.wine': sourceId }] }
    ),
    WineList.updateMany(
      { 'sections.entries.wine': sourceId },
      { $set: { 'sections.$[].entries.$[e].wine': keeperId } },
      { arrayFilters: [{ 'e.wine': sourceId }] }
    ),
  ]);
}

// Re-point a source wine's maturity profiles onto the keeper, reconciling the
// unique (wineDefinition, vintage) index. A plain updateMany would throw E11000
// whenever BOTH wines already have a profile for the same vintage — common now
// that every added/imported bottle seeds a pending profile — which would abort
// the whole merge. Per source profile:
//   - keeper has none for that vintage  → move it (re-point in place)
//   - keeper has only a 'pending' one, source is 'reviewed' → keep the curated
//     source window (drop the keeper's pending, then re-point the source's)
//   - otherwise (keeper already 'reviewed', or both 'pending') → drop the
//     source's; the keeper is the golden record and wins ties.
// Idempotent + re-runnable: moved/dropped source profiles are simply not found
// on a re-run. Errors propagate to the route's catch (sources deleted last).
async function reassignVintageProfiles(sourceId, keeperId) {
  const sourceProfiles = await WineVintageProfile
    .find({ wineDefinition: sourceId }).select('vintage status').lean();
  if (sourceProfiles.length === 0) return;
  const keeperProfiles = await WineVintageProfile
    .find({ wineDefinition: keeperId }).select('vintage status').lean();
  const keeperByVintage = new Map(keeperProfiles.map(p => [p.vintage, p]));

  for (const sp of sourceProfiles) {
    const kp = keeperByVintage.get(sp.vintage);
    if (!kp) {
      await WineVintageProfile.updateOne({ _id: sp._id }, { $set: { wineDefinition: keeperId } });
      // Track it so a second source with the same vintage reconciles against this one.
      keeperByVintage.set(sp.vintage, { vintage: sp.vintage, status: sp.status });
    } else if (kp.status !== 'reviewed' && sp.status === 'reviewed') {
      await WineVintageProfile.deleteOne({ wineDefinition: keeperId, vintage: sp.vintage });
      await WineVintageProfile.updateOne({ _id: sp._id }, { $set: { wineDefinition: keeperId } });
      keeperByVintage.set(sp.vintage, { vintage: sp.vintage, status: 'reviewed' });
    } else {
      await WineVintageProfile.deleteOne({ _id: sp._id });
    }
  }
}

// Re-point docs of a model that has a UNIQUE index of (wineDefinition + keyFields)
// from source→keeper, reconciling collisions a plain updateMany would choke on.
// Per source doc: if the keeper has no doc with the same key it is moved in place;
// otherwise the keeper's row wins — onCollision (if given) merges anything worth
// keeping off the source doc, then the source doc is dropped.
// Idempotent + re-runnable: already-moved/dropped source docs aren't found again.
async function reassignKeyedRefs(Model, sourceId, keeperId, keyFields, onCollision) {
  const sourceDocs = await Model.find({ wineDefinition: sourceId }).lean();
  if (sourceDocs.length === 0) return;
  const keyOf = (d) => keyFields.map(f => String(d[f] ?? '')).join('|');
  const keeperDocs = await Model.find({ wineDefinition: keeperId })
    .select(keyFields.join(' ')).lean();
  const keeperKeys = new Set(keeperDocs.map(keyOf));

  for (const sd of sourceDocs) {
    const k = keyOf(sd);
    if (!keeperKeys.has(k)) {
      await Model.updateOne({ _id: sd._id }, { $set: { wineDefinition: keeperId } });
      keeperKeys.add(k); // a later source doc with the same key now collides
    } else {
      if (onCollision) await onCollision(sd, keeperId);
      await Model.deleteOne({ _id: sd._id });
    }
  }
}

// Collision handler for PriceTrackingRequest: fold the colliding source request's
// requesters (deduped by user) into the keeper's existing request for that vintage
// so no opted-in user loses their price-tracking notification, and widen the
// first/last-requested span across both.
async function mergePriceTrackingRequesters(sourceDoc, keeperId) {
  const keeperReq = await PriceTrackingRequest.findOne({ wineDefinition: keeperId, vintage: sourceDoc.vintage });
  if (!keeperReq) return; // collision implies it exists, but stay defensive
  const have = new Set(keeperReq.requesters.map(r => String(r.user)));
  let changed = false;
  for (const r of sourceDoc.requesters || []) {
    if (!have.has(String(r.user))) { keeperReq.requesters.push(r); have.add(String(r.user)); changed = true; }
  }
  if (sourceDoc.firstRequestedAt && sourceDoc.firstRequestedAt < keeperReq.firstRequestedAt) {
    keeperReq.firstRequestedAt = sourceDoc.firstRequestedAt; changed = true;
  }
  if (sourceDoc.lastRequestedAt && sourceDoc.lastRequestedAt > keeperReq.lastRequestedAt) {
    keeperReq.lastRequestedAt = sourceDoc.lastRequestedAt; changed = true;
  }
  if (changed) await keeperReq.save();
}

// Re-point the source wine inside RestockAlert.similarWineIds[] (an array ref).
// $addToSet the keeper first (while the source still matches the filter), then
// $pull the source — so the keeper isn't duplicated if it was already present.
// Idempotent: a re-run finds no remaining source entries to match.
async function reassignRestockSimilar(sourceId, keeperId) {
  await RestockAlert.updateMany({ similarWineIds: sourceId }, { $addToSet: { similarWineIds: keeperId } });
  await RestockAlert.updateMany({ similarWineIds: sourceId }, { $pull: { similarWineIds: sourceId } });
}

// Reassign every reference from one source wine to the keeper. Idempotent
// (updateMany by wineDefinition) and does NOT delete the source, so it's safe
// to re-run after a partial failure. Returns the number of bottles moved.
async function reassignWineRefs(sourceId, keeperId) {
  const bottleRes = await Bottle.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } });
  await Promise.all([
    reassignWineListEntries(sourceId, keeperId),
    BottleImage.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Maturity profiles need collision reconciliation (unique wineDefinition+vintage).
    reassignVintageProfiles(sourceId, keeperId),
    WineVintagePrice.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    WineReport.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    Discussion.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    DiscussionReply.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Delete the source's vectors from Qdrant too, not just the bookkeeping rows.
    purgeSourceVectors(sourceId),
    // Drop any "not duplicate" decisions referencing the disappearing source.
    WineNotDuplicate.deleteMany({ $or: [{ wineA: sourceId }, { wineB: sourceId }] }),
    // Reviews have no unique index on (author, wineDefinition) — a user may
    // hold several reviews per wine — so a plain re-point cannot collide.
    Review.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Wishlist items: re-point so a user who wishlisted the source wine doesn't
    // end up pointing at a deleted one. No unique index here, so a plain re-point
    // is safe; a user who wanted both merged wines may briefly see two rows —
    // prefer a removable dupe over silent loss (same policy as wine-list entries).
    WishlistItem.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Price-tracking opt-ins (unique wineDefinition+vintage): merge requesters on
    // collision so nobody loses their notification; otherwise move the request.
    reassignKeyedRefs(PriceTrackingRequest, sourceId, keeperId, ['vintage'], mergePriceTrackingRequesters),
    // Price-tracking skips (unique wineDefinition+vintage): keeper's skip wins.
    reassignKeyedRefs(PriceTrackingSkip, sourceId, keeperId, ['vintage']),
    // Community prices are a DERIVED aggregate (communityPriceJob recomputes them
    // from bottles). Re-pointing a stale median would be wrong — just drop the
    // source's; the job rebuilds the keeper's from the now-merged bottle set.
    CommunityWinePrice.deleteMany({ wineDefinition: sourceId }),
    // Remaining WineDefinition references that use a non-`wineDefinition` field
    // name — re-point so they don't dangle when the source wine is deleted. None
    // has a unique index on the wine ref, so a plain updateMany is safe.
    // JournalEntry holds the wine ref nested in pairings[].wine (not top-level),
    // so it needs an arrayFilter like the wine-list entries above.
    JournalEntry.updateMany(
      { 'pairings.wine': sourceId },
      { $set: { 'pairings.$[e].wine': keeperId } },
      { arrayFilters: [{ 'e.wine': sourceId }] }
    ),
    Recommendation.updateMany({ wine: sourceId }, { $set: { wine: keeperId } }),
    RestockAlert.updateMany({ wine: sourceId }, { $set: { wine: keeperId } }),
    reassignRestockSimilar(sourceId, keeperId),
    WineReport.updateMany({ duplicateOf: sourceId }, { $set: { duplicateOf: keeperId } }),
    WineRequest.updateMany({ linkedWineDefinition: sourceId }, { $set: { linkedWineDefinition: keeperId } }),
  ]);
  return bottleRes.modifiedCount || 0;
}

// POST /api/admin/wines/merge — "golden record" merge.
// Absorbs every wine in sourceIds INTO keeperId: reassigns all references,
// sets the admin-chosen surviving image, then deletes the sources. The keeper's
// own fields are composed separately by the client (PUT /:id) before this call.
//
// No DB transaction: this deployment runs a standalone mongod (no replica set),
// so we rely on idempotent reassigns + deleting sources LAST. A failure mid-way
// leaves the sources intact and the operation safely re-runnable.
router.post('/merge', async (req, res) => {
  try {
    const { keeperId, sourceIds, imageFromWineId } = req.body;

    if (!isValidId(keeperId)) {
      return res.status(400).json({ error: 'A valid keeperId is required' });
    }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      return res.status(400).json({ error: 'sourceIds must be a non-empty array' });
    }
    const ids = [...new Set(sourceIds.filter(id => isValidId(id) && id !== keeperId))];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid source ids (distinct from the keeper) provided' });
    }
    if (imageFromWineId != null && !isValidId(imageFromWineId)) {
      return res.status(400).json({ error: 'Invalid imageFromWineId' });
    }

    // Cast the validated id strings to ObjectId before they touch any query.
    // isValidId already guarantees each is a string in ObjectId format (so no
    // operator-injection is possible); constructing ObjectIds also clears the
    // static-analysis "user input flows into a DB query" taint.
    const keeperOid = new mongoose.Types.ObjectId(keeperId);
    const sourceOids = ids.map(id => new mongoose.Types.ObjectId(id));
    const imageOid = imageFromWineId ? new mongoose.Types.ObjectId(imageFromWineId) : null;

    const keeper = await WineDefinition.findById(keeperOid);
    if (!keeper) return res.status(404).json({ error: 'Keeper wine not found' });
    const sources = await WineDefinition.find({ _id: { $in: sourceOids } });
    if (sources.length === 0) return res.status(404).json({ error: 'No source wines found' });

    // Capture the admin's chosen surviving image BEFORE the reassign — after it,
    // the image's wineDefinition flips to the keeper. imageFromWineId names which
    // wine's primary photo should win (the keeper or any source).
    let chosenImage = null;
    if (imageOid) {
      chosenImage = await BottleImage.findOne({ wineDefinition: imageOid, assignedToWine: true })
        .select('_id processedUrl originalUrl credit');
    }

    let bottlesMoved = 0;
    for (const src of sources) {
      bottlesMoved += await reassignWineRefs(src._id, keeperOid);
    }

    // Apply the image choice. After the reassign every image points at the
    // keeper, so flip the chosen one to primary and demote the rest.
    let imageAction = 'kept';
    if (chosenImage) {
      await BottleImage.updateMany({ wineDefinition: keeperOid, _id: { $ne: chosenImage._id }, assignedToWine: true }, { $set: { assignedToWine: false } });
      await BottleImage.findByIdAndUpdate(chosenImage._id, { assignedToWine: true });
      keeper.image = chosenImage.processedUrl || chosenImage.originalUrl;
      keeper.imageCredit = chosenImage.credit || null;
      await keeper.save();
      imageAction = 'set_chosen';
    } else if (!keeper.image) {
      // No explicit choice and the keeper had no image — adopt any image now on it.
      const any = await BottleImage.findOne({ wineDefinition: keeperOid, assignedToWine: true }).select('processedUrl originalUrl credit');
      if (any) {
        keeper.image = any.processedUrl || any.originalUrl;
        keeper.imageCredit = any.credit || null;
        await keeper.save();
        imageAction = 'adopted';
      }
    }

    // Carry the best source AI tasting profile to the keeper if it has none, so
    // the re-embed below encodes taste/style instead of losing it on merge.
    await inheritAiProfileIfMissing(keeper, sources);

    // Delete sources LAST.
    for (const src of sources) {
      logAudit(req, 'admin.wine.merge', { type: 'wine', id: src._id }, {
        sourceName: src.name, sourceProducer: src.producer,
        keeperId: keeper._id, keeperName: keeper.name, keeperProducer: keeper.producer,
        bottlesMoved, imageAction, golden: true,
      });
      await src.deleteOne();
      searchService.removeWine(src._id.toString());
    }
    searchService.indexWine(keeper._id.toString());

    // Re-index the keeper's bottles: reassignWineRefs re-pointed the sources'
    // bottles, but their search documents still carry the DELETED source
    // wine's denormalized name/producer/taxonomy — without this, cellar
    // search keeps matching/faceting them under the old wine forever.
    Bottle.distinct('_id', { wineDefinition: keeperOid })
      .then(ids => searchService.bulkIndexBottles(ids))
      .catch(err => console.error('Bottle re-index after merge failed:', err.message));

    // Re-embed the keeper's vintages so semantic search reflects the merged wine.
    reembedKeeper(keeper._id);

    res.json({ message: 'Wines merged successfully', sourcesMerged: sources.length, bottlesMoved, imageAction });
  } catch (error) {
    console.error('Golden merge error:', error);
    res.status(500).json({ error: 'Failed to merge wines' });
  }
});

module.exports = router;
