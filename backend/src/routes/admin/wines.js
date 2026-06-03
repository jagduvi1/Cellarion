const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const {
  generateWineKey,
  calculateSimilarity,
  combinedSimilarity,
  trigramSimilarity,
  tokenSimilarity,
  normalizeString
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
const vectorStore = require('../../services/vectorStore');
const { embedSinglePair } = require('../../services/embeddingJob');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const { isValidId } = require('../../utils/validation');
const { escapeRegex } = require('../../utils/sanitize');

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

    // Group by normalised producer
    const byProducer = new Map();
    for (const wine of wines) {
      const key = normalizeString(wine.producer || '');
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
          const score = scoreWineMatch(
            { name: a.name, producer: a.producer, appellation: a.appellation },
            { name: b.name, producer: b.producer, appellation: b.appellation },
            { redistribute: false }
          );
          if (score >= minScore) {
            union(aId, bId);
            const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
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
    if (appellation !== undefined) wine.appellation = appellation?.trim();
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
      // Delete the source's vectors from Qdrant + WineEmbedding (deleting the
      // bookkeeping rows alone would orphan the actual vectors in Qdrant).
      purgeSourceVectors(sourceId),
    ]);

    const bottlesMoved = results[0].modifiedCount || 0;

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
    console.warn(`[merge] purge source vectors failed (${sourceId}):`, err.message);
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
    console.warn(`[merge] re-embed keeper failed (${keeperId}):`, err.message);
  }
}

// Reassign every reference from one source wine to the keeper. Idempotent
// (updateMany by wineDefinition) and does NOT delete the source, so it's safe
// to re-run after a partial failure. Returns the number of bottles moved.
async function reassignWineRefs(sourceId, keeperId) {
  const bottleRes = await Bottle.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } });
  await Promise.all([
    BottleImage.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    WineVintageProfile.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    WineVintagePrice.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    WineReport.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    Discussion.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    DiscussionReply.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } }),
    // Delete the source's vectors from Qdrant too, not just the bookkeeping rows.
    purgeSourceVectors(sourceId),
    // Reviews have a unique (author, wineDefinition) index — on a real dup-key
    // collision the source author already reviewed the keeper, so drop the
    // source's duplicate review. Re-throw anything that isn't a dup-key error.
    Review.updateMany({ wineDefinition: sourceId }, { $set: { wineDefinition: keeperId } })
      .catch(err => { if (err.code === 11000) return Review.deleteMany({ wineDefinition: sourceId }); throw err; }),
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

    // Re-embed the keeper's vintages so semantic search reflects the merged wine.
    reembedKeeper(keeper._id);

    res.json({ message: 'Wines merged successfully', sourcesMerged: sources.length, bottlesMoved, imageAction });
  } catch (error) {
    console.error('Golden merge error:', error);
    res.status(500).json({ error: 'Failed to merge wines' });
  }
});

module.exports = router;
