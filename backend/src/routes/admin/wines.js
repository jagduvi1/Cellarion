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
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const { validateImageRef } = require('../../services/accountOps');
const { scoreWineMatch } = require('../../services/wineMatching');
const { conflictingStyleTerms } = require('../../utils/styleTerms');
const { sameProducerAppellationGroups, nearProducerPairs, nameSubsetPairs } = require('../../services/registryFragmentation');
const {
  incompleteGeographyRows, stillIncomplete, GEOGRAPHY_INCOMPLETE_CHECK_ID,
} = require('../../services/registryCompleteness');
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
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const { repointInquiriesForWineMerge, closeInquiriesForWineDelete } = require('../../services/ownerInquiryOps');
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
const { stripProducerName, stripProducerKeyPrefix, canonicalizeWineName } = require('../../utils/producerPrefix');
const {
  NAME_CHECKS, NAME_CHECK_IDS, DEFAULT_CHECK_IDS, NAME_CHECK_SELECT,
  resolveCheck, runNameChecks,
} = require('../../utils/nameChecks');
const {
  CROSS_FIELD_CHECK_IDS, DEFAULT_CROSS_FIELD_CHECK_IDS,
  CROSS_FIELD_CHECK_LABEL_KEYS, CROSS_FIELD_CHECK_FIELDS,
  resolveCrossFieldCheck,
} = require('../../utils/crossFieldChecks');
const { scanCrossFieldChecks, detectCrossFieldForWines } = require('../../services/crossFieldScan');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');

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
//
// This endpoint used to bypass EVERY dedup layer (step-0 strip, sibling match,
// fuzzy soft zone) and rely on the raw unique key alone, so only verbatim
// duplicates were stopped (dup analysis 2026-07-22, RC4). It now canonicalizes
// like every other write surface and probes the shared matcher first; a
// likely duplicate returns 409 with the candidates so the admin can link or
// merge instead — or resubmit with confirmCreate:true after an explicit
// "create anyway".
router.post('/', async (req, res) => {
  try {
    const { name, producer, country, region, appellation, grapes, type, image, confirmCreate } = req.body;

    if (!name || !producer || !country) {
      return res.status(400).json({ error: 'Name, producer, and country are required' });
    }
    if (typeof name !== 'string' || typeof producer !== 'string') {
      return res.status(400).json({ error: 'Name and producer must be strings' });
    }
    if (!isValidId(String(country))) {
      return res.status(400).json({ error: 'Invalid country' });
    }

    const cleanProducer = producer.trim();
    const cleanName = canonicalizeWineName(name, cleanProducer);
    // Resolved, not just tier-stripped: this branch writes the WineDefinition
    // directly, so without the curated-registry lookup an admin create
    // reintroduces the spelling variants the mint chokepoint folds. One
    // resolution serves the dedup probe, the key and the stored field.
    const cleanAppellation = await resolveCanonicalAppellation(
      normalizeAppellation(typeof appellation === 'string' ? appellation.trim() : null)
    ) || null;

    if (!confirmCreate) {
      const countryDoc = await Country.findById(String(country)).select('name').lean().catch(() => null);
      const probe = await findOrCreateWine(
        {
          name: cleanName, producer: cleanProducer, country: countryDoc?.name || '',
          region: '', appellation: cleanAppellation || '', type, grapes: [],
        },
        req.user.id,
        { matchOnly: true }
      );
      const dupes = probe.wine ? [{ wine: probe.wine, score: 1 }] : (probe.candidates || []);
      if (dupes.length > 0) {
        return res.status(409).json({
          error: 'Very similar registry wine(s) already exist — link or merge instead, or create anyway if this is genuinely different.',
          candidates: dupes.map(d => ({
            _id: d.wine._id,
            name: d.wine.name,
            producer: d.wine.producer,
            appellation: d.wine.appellation || null,
            score: d.score,
          })),
        });
      }
    }

    // A producer that IS an appellation/region/country/grape/style-term is
    // refused on this deliberate curation surface with the same 400 the mint
    // chokepoint gives (release-audit MED-3: this route builds the row
    // directly, so without its own gate an admin could still publish
    // producer "Sangiovese" here while every other surface refuses it).
    {
      const { detectBlockingProducerIssue } = require('../../services/crossFieldScan');
      const blocked = await detectBlockingProducerIssue({ name: cleanName, producer: cleanProducer, appellation: cleanAppellation || '' });
      if (blocked) {
        return res.status(400).json({
          error: `"${cleanProducer}" is not a usable producer name — cross-field rule ${blocked.check} matched "${blocked.detail}", which belongs in a different field`,
        });
      }
    }

    // Adopt the registry's existing spelling for this producer (same-string
    // majority + same-country decoration variants), mirroring the mint
    // chokepoint — this branch writes the row directly, so without the call an
    // admin create was one of the two surfaces that could still mint a
    // display split ("Weingut Steininger" ×1 beside "Steininger" ×N came from
    // exactly this hole). Fail-open: on any ambiguity the typed spelling is
    // stored unchanged.
    const { resolveCanonicalProducerSpelling } = require('../../services/producerSpelling');
    const producerToStore = await resolveCanonicalProducerSpelling(
      cleanProducer, normalizeString(cleanProducer), { countryId: String(country) }
    );

    // Generate normalized key for deduplication
    const normalizedKey = generateWineKey(cleanName, producerToStore, cleanAppellation);

    // The image lands on a public page and in every viewer's AuthImage, so it
    // has to be a real http(s) link, an inline image or one of our own upload
    // paths (audit 2026-09 S7-1 / F06-1).
    const imageErr = validateImageRef(image);
    if (imageErr) return res.status(400).json({ error: `Wine image: ${imageErr}` });

    const wine = new WineDefinition({
      name: cleanName,
      producer: producerToStore,
      country,
      region: region || null,
      appellation: cleanAppellation,
      grapes: grapes || [],
      type: type || null, // no guessed red (ticket 6a85ad44)
      image: image || null,
      normalizedKey,
      createdBy: req.user.id,
      createdVia: 'ui'
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
      { buffer, wineDefinitionId: wine._id, credit: credit ? String(credit).trim() : null, userId: req.user.id, userRoles: req.user.roles },
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
    // Quarantined non-wines are excluded: a whisky must never be offered as a
    // merge candidate against a wine (#844's stated contract, which this pool
    // was missed out of — code audit 2026-07-27, H3).
    const wines = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
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
          // Names stating a DIFFERENT Prädikat/sweetness are a producer's
          // range, not duplicates (#1134 follow-up): a Mosel estate's whole
          // range scores 0.83–0.90 pairwise, far above the default 0.6 floor,
          // and would cluster as the scan's top proposal — one admin merge
          // from collapsing every user's bottles across it. Same shape as
          // the dismissed-edge skip above, and reject-only like every other
          // consumer of this guard: it can only drop a proposed merge, never
          // propose one, and it spares the n² manual dismissals a surfaced
          // range would otherwise cost.
          if (conflictingStyleTerms(a.name, b.name)) continue;
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

// POST /api/admin/wines/verify-checks — record that an admin read these wines
// and confirmed they pass these specific name checks, so the scan stops
// surfacing them FOR THOSE CHECKS ONLY. A check added later has no clearance
// on any row and surfaces the whole registry. DELETE undoes it.
// Body: { wineIds: [id, …], checks: [ruleId, …] }   (1..N ids)
//
// `checks` is required with no "all" default — a hidden default-to-everything
// would be exactly the bare-flag semantics this design rejects; the client
// always has the row's `checks` array to send. No MCP tool exists for this on
// purpose: "a human checked this" asserted by an AI defeats the record.
router.post('/verify-checks', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 1) return res.status(400).json({ error: 'wineIds must contain at least 1 valid id' });
    if (ids.length > 500) return res.status(400).json({ error: 'At most 500 wineIds per call' });

    const raw = Array.isArray(req.body?.checks) ? req.body.checks : null;
    const specs = (raw || []).map(resolveCheck);
    if (!raw || raw.length === 0 || specs.some(s => !s)) {
      return res.status(400).json({ error: 'checks must be a non-empty array of known check ids' });
    }
    const checkIds = [...new Set(specs.map(s => s.id))];

    const oids = ids.map(id => new mongoose.Types.ObjectId(id));
    const wines = await WineDefinition.find({ _id: { $in: oids } })
      .select(NAME_CHECK_SELECT).lean();
    if (wines.length === 0) return res.status(404).json({ error: 'No matching wines' });

    // Re-run the rules server-side, exactly as strip-producer recomputes its
    // check — a stale client row must not be able to clear a rule the admin
    // never actually saw on screen.
    const now = new Date();
    const ops = [];
    const notFlagged = [];
    for (const w of wines) {
      const hit = runNameChecks(w, { checkIds, ignoreCleared: true });
      if (!hit) { notFlagged.push(String(w._id)); continue; }
      ops.push({ updateOne: {
        filter: { _id: w._id },
        // $addToSet is idempotent, so re-verifying is safe and ordering is
        // irrelevant (no $pull/$push pairing on the same path).
        update: { $addToSet: { verifiedChecks: { $each: hit.checks } }, $set: { verifiedAt: now } },
      } });
    }
    // Nothing searchable, embeddable or public changed: deliberately NO
    // searchService.indexWine, NO embedSinglePair, NO submitUrls.
    const result = ops.length ? await WineDefinition.bulkWrite(ops, { ordered: false }) : { modifiedCount: 0 };

    logAudit(req, 'admin.wine.verifyChecks', { type: 'wine', id: ids[0] },
      { wineIds: ids, checks: checkIds, updated: result.modifiedCount || 0, notFlagged: notFlagged.length });
    res.json({ message: 'Recorded', updated: result.modifiedCount || 0, checks: checkIds, notFlagged });
  } catch (error) {
    console.error('Verify checks error:', error);
    res.status(500).json({ error: 'Failed to record verification' });
  }
});

// DELETE /api/admin/wines/verify-checks — undo the above.
// verifiedAt is deliberately left as-is: it is display/forensics metadata
// ("last reviewed"), not the suppression key.
router.delete('/verify-checks', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 1) return res.status(400).json({ error: 'wineIds must contain at least 1 valid id' });
    if (ids.length > 500) return res.status(400).json({ error: 'At most 500 wineIds per call' });

    const raw = Array.isArray(req.body?.checks) ? req.body.checks : null;
    const specs = (raw || []).map(resolveCheck);
    if (!raw || raw.length === 0 || specs.some(s => !s)) {
      return res.status(400).json({ error: 'checks must be a non-empty array of known check ids' });
    }
    const checkIds = [...new Set(specs.map(s => s.id))];

    const result = await WineDefinition.updateMany(
      { _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } },
      { $pull: { verifiedChecks: { $in: checkIds } } }
    );
    logAudit(req, 'admin.wine.unverifyChecks', { type: 'wine', id: ids[0] },
      { wineIds: ids, checks: checkIds, updated: result.modifiedCount || 0 });
    res.json({ message: 'Verification cleared', updated: result.modifiedCount || 0 });
  } catch (error) {
    console.error('Unverify checks error:', error);
    res.status(500).json({ error: 'Failed to clear verification' });
  }
});

// POST /api/admin/wines/:id/non-wine — quarantine (or restore) a row that is
// not a wine (spirits/cider/sake; registry audit 2026-07-26, policy: keep,
// hide). Body: { value: boolean }. The row and its owners' bottles keep
// working; flagged rows leave the search index (indexWine self-heals), the
// public taxonomy/OG/sitemap listings and the admin duplicate-scan pools.
router.post('/:id/non-wine', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    if (typeof req.body?.value !== 'boolean') {
      return res.status(400).json({ error: 'value must be a boolean' });
    }
    const wine = await WineDefinition.findById(req.params.id);
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    wine.nonWine = req.body.value;
    await wine.save();
    // Self-healing index sync: indexWine removes flagged rows, re-adds restored ones.
    searchService.indexWine(wine._id);

    logAudit(req, 'admin.wine.nonWine', { type: 'wine', id: wine._id },
      { value: req.body.value, name: wine.name, producer: wine.producer });
    res.json({ message: req.body.value ? 'Quarantined as non-wine' : 'Restored as wine', nonWine: wine.nonWine });
  } catch (error) {
    console.error('Non-wine toggle error:', error);
    res.status(500).json({ error: 'Failed to update non-wine flag' });
  }
});

// POST /api/admin/wines/:id/profile-reviewed — record that an admin read this
// low-confidence wine and judged its data correct as of the CURRENT profile.
// DELETE undoes it. Self-invalidating by timestamp comparison (see GET above),
// so there is nothing to clear on later edits.
router.post('/:id/profile-reviewed', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wine = await WineDefinition.findById(req.params.id).select('name producer aiProfile.heldAt');
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    // A HELD profile + an admin review = the human override the hold was
    // waiting for: regenerate and PUBLISH (the suspect flag stays on the row
    // as provenance). The review stamp lands ONLY when the publish succeeds
    // (inside releaseHeldProfile) — stamping first, as v1.116.0 did, hid the
    // row from the queue forever when the AI call failed, because the
    // outstanding filter compares reviewedAt to generatedAt and the
    // incremental job skips held rows by design (audit 2026-08-16). On
    // failure the row simply stays in the queue for another click. If the
    // admin instead agrees the identity is wrong, the fix is the wine editor
    // — the identity edit re-enriches.
    if (wine.aiProfile?.heldAt) {
      const { releaseHeldProfile } = require('../../services/enrichmentJob');
      releaseHeldProfile(wine._id).catch(() => {});
      logAudit(req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
        { name: wine.name, producer: wine.producer, heldRelease: true });
      return res.json({ message: 'Publishing the held profile', profileReviewedAt: null });
    }

    const now = new Date();
    await WineDefinition.updateOne({ _id: wine._id }, { $set: { profileReviewedAt: now } });
    logAudit(req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer });
    res.json({ message: 'Marked reviewed', profileReviewedAt: now });
  } catch (error) {
    console.error('Profile-reviewed error:', error);
    res.status(500).json({ error: 'Failed to mark reviewed' });
  }
});

router.delete('/:id/profile-reviewed', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const result = await WineDefinition.updateOne(
      { _id: req.params.id }, { $set: { profileReviewedAt: null } });
    if (!result.matchedCount) return res.status(404).json({ error: 'Wine not found' });
    logAudit(req, 'admin.wine.profileUnreviewed', { type: 'wine', id: req.params.id }, {});
    res.json({ message: 'Review cleared' });
  } catch (error) {
    console.error('Profile-unreviewed error:', error);
    res.status(500).json({ error: 'Failed to clear review' });
  }
});

// GET /api/admin/wines/low-confidence — the "model in doubt" review queue.
// Surfaces wines whose enrichment confidence is at or below ?threshold
// (default 0.3 — the band that caught the Arcane range-as-producer row),
// EXCLUDING rows an admin already reviewed SINCE their profile was last
// generated: profileReviewedAt >= aiProfile.generatedAt suppresses; a
// re-enrichment bumps generatedAt past the review and the row re-surfaces
// by comparison alone. ?includeReviewed=1 is the audit view. Sorted most
// doubtful first. producerSuspect/producerNote ride along so the model's
// specific worry is visible per row.
router.get('/low-confidence', async (req, res) => {
  try {
    const { limit: parsedLimit, offset: skip, page: parsedPage } =
      parsePagination(req.query, { limit: 50, maxLimit: 200 });
    const rawT = Number(req.query.threshold);
    const threshold = Number.isFinite(rawT) ? Math.min(Math.max(rawT, 0), 1) : 0.3;
    const includeReviewed = req.query.includeReviewed === '1' || req.query.includeReviewed === 'true';

    // A null confidence means the generator gave us nothing usable — no number,
    // a non-numeric string, or Infinity from a `1e400` in the JSON. That is not
    // a confident row; it is a row nobody can vouch for, and `$ne: null` was
    // excluding exactly those from the queue built to catch them. Sanitising bad
    // model output to null (security audit 2026-08-03, M-2) only made that worse
    // — it routed every unusable value into the one state guaranteed to hide.
    // Unknown now means "review me", which is also how the two rows already
    // sitting invisible in prod get seen.
    const base = {
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      $or: [
        { 'aiProfile.confidence': null },
        { 'aiProfile.confidence': { $lte: threshold } },
        // A suspect producer is a doubt about the IDENTITY, not the profile's
        // confidence — Fabelhaft's flagged at 0.5 while the default threshold
        // is 0.3, so the one row the flag existed for never surfaced here
        // (ticket 6a8162c5). Suspect rows appear regardless of threshold, and
        // their profiles are HELD unpublished until someone in this queue
        // decides.
        //
        // Since the 2026-08-17 split this branch means what it says: the
        // producer FIELD looks wrong. producerUnknown ("a real winery name I
        // cannot place") is deliberately NOT a branch here — it describes most
        // small estates in the registry and is not review work, so listing it
        // would bury the rows that are genuinely wrong. It rides on each row
        // for context instead.
        { 'aiProfile.producerSuspect': true },
        // Every HELD row surfaces regardless of threshold (gate 2026-08-18,
        // ticket 6a83e765): an unknown-producer hold can sit at 0.5 —
        // above the default threshold with no suspect flag — and this queue
        // is the only place a hold gets released. heldReason says why.
        { 'aiProfile.heldAt': { $ne: null } },
      ],
      // Only rows that were actually enriched — without this, every wine that
      // has no aiProfile at all would match the null branch above.
      'aiProfile.generatedAt': { $ne: null },
    };
    const outstanding = {
      ...base,
      $expr: {
        $or: [
          { $eq: ['$profileReviewedAt', null] },
          { $lt: ['$profileReviewedAt', '$aiProfile.generatedAt'] },
        ],
      },
    };

    const filter = includeReviewed ? base : outstanding;
    const [rows, total, reviewedCount] = await Promise.all([
      WineDefinition.find(filter)
        .select('name producer appellation nonWine profileReviewedAt aiProfile.confidence aiProfile.description aiProfile.producerSuspect aiProfile.producerUnknown aiProfile.producerNote aiProfile.generatedAt aiProfile.heldAt aiProfile.heldReason')
        .populate('region', 'name')
        .populate('country', 'name')
        .sort({ 'aiProfile.confidence': 1, producer: 1 })
        .skip(skip)
        .limit(parsedLimit)
        .lean(),
      WineDefinition.countDocuments(filter),
      WineDefinition.countDocuments(base).then(async (all) =>
        all - await WineDefinition.countDocuments(outstanding)),
    ]);

    const bottleCounts = new Map();
    if (rows.length > 0) {
      const counts = await Bottle.aggregate([
        { $match: { wineDefinition: { $in: rows.map(w => w._id) } } },
        { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
      ]);
      for (const c of counts) bottleCounts.set(String(c._id), c.count);
    }

    res.json({
      wines: rows.map(w => ({
        _id: w._id,
        name: w.name,
        producer: w.producer,
        appellation: w.appellation || null,
        region: w.region?.name || null,
        country: w.country?.name || null,
        confidence: w.aiProfile?.confidence ?? null,
        description: w.aiProfile?.description || null,
        producerSuspect: w.aiProfile?.producerSuspect === true,
        producerUnknown: w.aiProfile?.producerUnknown === true,
        producerNote: w.aiProfile?.producerNote || null,
        generatedAt: w.aiProfile?.generatedAt || null,
        heldAt: w.aiProfile?.heldAt || null,
        heldReason: w.aiProfile?.heldReason || null,
        profileReviewedAt: w.profileReviewedAt || null,
        bottleCount: bottleCounts.get(String(w._id)) || 0,
      })),
      total,
      page: parsedPage,
      pages: Math.ceil(total / parsedLimit),
      threshold,
      reviewedCount,
    });
  } catch (error) {
    console.error('Low-confidence list error:', error);
    res.status(500).json({ error: 'Failed to list low-confidence wines' });
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
    // Both candidate queries exclude quarantined non-wines, same contract as
    // the other duplicate pools (code audit 2026-07-27, H3).
    const [textHits, regexHits] = await Promise.all([
      WineDefinition.find({ $text: { $search: searchTerms }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
        .populate(['country', 'region', 'grapes'])
        .limit(CANDIDATE_LIMIT),
      WineDefinition.find({
        nonWine: { $ne: true }, pendingIdentity: { $ne: true },
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

// GET /api/admin/wines/canonical-collisions — the standing duplicate queue
// (dup analysis 2026-07-22, phases 1-2). Groups wines by canonicalKey; every
// group of ≥2 is either a real duplicate (→ merge tool) or a legitimate
// same-name collision (→ dismiss via the not-a-duplicate flow, which hides it
// here too). DIFF-COUNTRY / DIFF-TYPE flags mark likely false positives
// (Domaine Chandon Napa vs Bodegas Chandon Mendoza). Healthy steady state:
// zero sets — new canonical duplicates can't be minted (findOrCreateWine
// resolves them), so anything appearing here entered via a raced write or a
// pre-backfill row and deserves a look.
router.get('/canonical-collisions', async (req, res) => {
  try {
    const wines = await WineDefinition.find({ canonicalKey: { $ne: null }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
      .select('name producer appellation type country canonicalKey createdAt createdVia')
      .populate('country', 'name')
      .lean();

    const groups = new Map();
    for (const w of wines) {
      let group = groups.get(w.canonicalKey);
      if (!group) { group = []; groups.set(w.canonicalKey, group); }
      group.push(w);
    }
    const collisions = [...groups.entries()].filter(([, arr]) => arr.length >= 2);

    // Sets where the admin has dismissed EVERY pair stop resurfacing.
    const notDup = await WineNotDuplicate.find({}).select('wineA wineB').lean();
    const dismissed = new Set(notDup.map(d => `${d.wineA}|${d.wineB}`));
    const pairKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);
    const active = collisions.filter(([, arr]) => {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (!dismissed.has(pairKey(arr[i]._id, arr[j]._id))) return true;
        }
      }
      return false;
    });

    const ids = active.flatMap(([, arr]) => arr.map(w => w._id));
    const bottleCounts = new Map();
    if (ids.length > 0) {
      const counts = await Bottle.aggregate([
        { $match: { wineDefinition: { $in: ids } } },
        { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
      ]);
      for (const c of counts) bottleCounts.set(String(c._id), c.count);
    }

    const totalBottles = (arr) => arr.reduce((s, w) => s + (bottleCounts.get(String(w._id)) || 0), 0);
    const sets = active
      .map(([key, arr]) => ({
        canonicalKey: key,
        flags: [
          new Set(arr.map(w => String(w.country?._id || ''))).size > 1 ? 'DIFF-COUNTRY' : null,
          new Set(arr.map(w => w.type)).size > 1 ? 'DIFF-TYPE' : null,
        ].filter(Boolean),
        wines: arr
          .map(w => ({
            _id: w._id,
            name: w.name,
            producer: w.producer,
            appellation: w.appellation || null,
            type: w.type,
            country: w.country?.name || null,
            createdAt: w.createdAt,
            createdVia: w.createdVia || null,
            bottleCount: bottleCounts.get(String(w._id)) || 0,
          }))
          .sort((a, b) => b.bottleCount - a.bottleCount),
      }))
      .sort((a, b) => totalBottles(groups.get(b.canonicalKey)) - totalBottles(groups.get(a.canonicalKey)));

    res.json({ sets, total: sets.length, scannedCount: wines.length });
  } catch (error) {
    console.error('Canonical collisions error:', error);
    res.status(500).json({ error: 'Failed to list canonical collisions' });
  }
});

// GET /api/admin/wines/producer-in-name — the registry NAME-CHECK scan. The
// path keeps its historical name (a rename churns working i18n keys and a
// live client for zero functional gain) but it now runs every defaultActive
// rule in utils/nameChecks.js:
//   producer-in-name.v1        — name starts/ends with its own producer,
//                                including key-token variants ("Felton Road
//                                Block 3 Pinot Noir" / "Felton Road Wines Ltd")
//   dangling-name-tail.v3      — name ends in a stranded connective
//                                ("La Viña de" — support ticket 2026-07-26)
//   name-equals-producer.v1    — name === producer, non-estate shape
// plus the non-default estate cohort via ?check=name-equals-producer-estate.v1.
//
// Query params:
//   ?check=<ruleId>      scope to one rule (default = every defaultActive rule)
//   ?includeVerified=1   AUDIT VIEW — ignore clearances entirely, so a newly
//                        added or refined rule can be validated against all
//                        ~4.3k rows before its suppression is trusted
//
// Rows an admin cleared via POST /verify-checks are suppressed PER RULE. The
// key-token check has no aggregation mirror, so the scan runs in Node — same
// full-fetch pattern (and cost) as the duplicate-clusters scan above, fine at
// the registry's ~4k-doc size.
//
// Returns: { wines: [{ _id, producer, name, proposedName, checks, verifiedChecks,
//   verifiedAt, bottleCount, createdAt }], total, page, pages, clearedCount,
//   scannedCount, checkIds, allCheckIds, checkLabelKeys }
router.get('/producer-in-name', async (req, res) => {
  try {
    const { limit: parsedLimit, offset: skip, page: parsedPage } =
      parsePagination(req.query, { limit: 50, maxLimit: 200 });

    const only = req.query.check;
    if (only !== undefined && !resolveCheck(only)) {
      return res.status(400).json({ error: 'Unknown check id' });
    }
    const checkIds = only ? [only] : DEFAULT_CHECK_IDS;
    const ignoreCleared = req.query.includeVerified === '1' || req.query.includeVerified === 'true';

    // Suppression is evaluated in Node, not as a Mongo clause, because a row
    // may be cleared for one rule and outstanding for another — and `total`
    // below is computed from flagged.length, so in-memory pagination stays
    // honest.
    const all = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
      .select(`${NAME_CHECK_SELECT} createdAt verifiedAt`)
      .sort({ producer: 1, name: 1 })
      .lean();

    const flagged = [];
    let clearedCount = 0;
    for (const w of all) {
      const hit = runNameChecks(w, { checkIds, ignoreCleared });
      if (hit) flagged.push({ ...w, ...hit });
      else if (checkIds.some(id => (w.verifiedChecks || []).includes(id))) clearedCount += 1;
    }

    const total = flagged.length;
    const pageRows = flagged.slice(skip, skip + parsedLimit);

    // Bottle counts for the page's rows in one aggregate
    const bottleCounts = new Map();
    if (pageRows.length > 0) {
      const counts = await Bottle.aggregate([
        { $match: { wineDefinition: { $in: pageRows.map(w => w._id) } } },
        { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
      ]);
      for (const c of counts) bottleCounts.set(String(c._id), c.count);
    }

    res.json({
      wines: pageRows.map(w => ({
        _id: w._id,
        producer: w.producer,
        name: w.name,
        proposedName: w.proposedName,           // null for the non-strippable rules
        checks: w.checks,                       // rule ids this row trips
        verifiedChecks: w.verifiedChecks || [], // for the audit view
        verifiedAt: w.verifiedAt || null,
        bottleCount: bottleCounts.get(String(w._id)) || 0,
        createdAt: w.createdAt,
      })),
      total,
      page: parsedPage,
      pages: Math.ceil(total / parsedLimit),
      clearedCount,
      scannedCount: all.length,
      checkIds,
      allCheckIds: NAME_CHECK_IDS,
      checkLabelKeys: NAME_CHECKS.reduce((m, c) => (m[c.id] = c.labelKey, m), {}),
    });
  } catch (error) {
    console.error('Producer-in-name scan error:', error);
    res.status(500).json({ error: 'Failed to scan for producer-in-name wines' });
  }
});

// GET /api/admin/wines/fragmentation?mode=groups|pairs — SAME-WINE
// fragmentation the name-keyed nets cannot see (curator ticket d4a0e96b):
//   groups — records sharing an exact producer + appellation key, with the
//            disjoint-vintage discriminator (see services/registryFragmentation)
//   pairs  — producer keys within edit distance 1..2 inside one
//            (country, appellation) bucket
// Review queues only — merging happens in the duplicates scanner; a groups-mode
// set dismissed via POST /dismiss-duplicates (the group's wine ids) stops
// resurfacing here exactly as in the canonical-collisions queue. Pairs mode has
// no dismissal (producer-level pairs don't map onto the wine-pair store).
// Query: mode (default groups), limit (default 50, max 200), offset|page
router.get('/fragmentation', async (req, res) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, { limit: 50, maxLimit: 200 });
    const mode = req.query.mode || 'groups';
    if (mode !== 'groups' && mode !== 'pairs' && mode !== 'name-subsets') {
      return res.status(400).json({ error: 'mode must be "groups", "pairs" or "name-subsets"' });
    }

    if (mode === 'groups') {
      const { groups, total, scannedCount } = await sameProducerAppellationGroups({ limit, offset });
      return res.json({ groups, total, page, pages: Math.ceil(total / limit), scannedCount });
    }

    if (mode === 'name-subsets') {
      // Short-vs-full name fragments within one producer (ticket 6a800f39:
      // "Vat 8" / "Vat 8 Shiraz Cabernet"). Pair-level dismissal works via
      // POST /dismiss-duplicates with the pair's two wine ids — same store
      // and keying as the groups mode.
      const { pairs, total, scannedCount, skippedBuckets } = await nameSubsetPairs({ limit, offset });
      return res.json({ pairs, total, page, pages: Math.ceil(total / limit), scannedCount, skippedBuckets });
    }

    const { pairs, total, scannedCount, skippedBuckets } = await nearProducerPairs({ limit, offset });
    res.json({ pairs, total, page, pages: Math.ceil(total / limit), scannedCount, skippedBuckets });
  } catch (error) {
    console.error('Fragmentation scan error:', error);
    res.status(500).json({ error: 'Failed to scan for fragmentation' });
  }
});

// GET /api/admin/wines/cross-field-checks — the CROSS-FIELD domain scan
// (ticket analysis 2026-08-10, Tier-2 item 5): registry values sitting in the
// wrong FIELD, tested against the reference lists the app already holds
// (utils/crossFieldChecks.js — producer that is an appellation/region/
// country/grape/style term/placeholder, parenthetical producers, name⊂producer
// splits, appellation that is a grape, region that is a country). Flags only,
// never blocks — this is the admin queue for the class findOrCreateWine's
// mint-time gate cannot see (un-promoted taxonomy, later-minted docs).
//
// Query params (same contract as /producer-in-name):
//   ?check=<ruleId>     scope to one rule (default = every defaultActive rule)
//   ?includeCleared=1   AUDIT VIEW — ignore clearances entirely, so a newly
//                       added or refined rule can be validated across the
//                       whole registry before its suppression is trusted
//
// Rows an admin cleared via POST /cross-checks-clear are suppressed PER RULE.
//
// Returns: { wines: [{ _id, name, producer, appellation, region, country,
//   hits: [{ check, detail }], cleared }], total, page, pages, clearedCount,
//   scannedCount, ruleCounts, checkIds, allCheckIds, checkLabelKeys,
//   checkFields }
router.get('/cross-field-checks', async (req, res) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, { limit: 50, maxLimit: 200 });

    const only = req.query.check;
    if (only !== undefined && !resolveCrossFieldCheck(only)) {
      return res.status(400).json({ error: 'Unknown check id' });
    }
    const checkIds = only ? [only] : DEFAULT_CROSS_FIELD_CHECK_IDS;
    const ignoreCleared = req.query.includeCleared === '1' || req.query.includeCleared === 'true';

    const { rows, ruleCounts, total, clearedCount, scannedCount } =
      await scanCrossFieldChecks({ checkIds, ignoreCleared });

    res.json({
      wines: rows.slice(offset, offset + limit)
        .map(r => ({ ...r.wine, hits: r.hits, cleared: r.cleared })),
      total,
      page,
      pages: Math.ceil(total / limit),
      clearedCount,
      scannedCount,
      ruleCounts,
      checkIds,
      allCheckIds: CROSS_FIELD_CHECK_IDS,
      // Built in the rules module so the DB-backed rules (computed in
      // services/crossFieldScan, not by a detect) are in the maps too.
      checkLabelKeys: CROSS_FIELD_CHECK_LABEL_KEYS,
      checkFields: CROSS_FIELD_CHECK_FIELDS,
    });
  } catch (error) {
    console.error('Cross-field checks scan error:', error);
    res.status(500).json({ error: 'Failed to scan for cross-field checks' });
  }
});

// GET /api/admin/wines/incomplete-geography — the COMPLETENESS queue: rows
// that are not wrong, just blank (services/registryCompleteness). Every other
// net keys off a value, so a region-less row trips nothing and sits invisible;
// 180 such rows were on prod when this shipped, 112 of them owned by real
// users. Sorted most-owned first, appellation leads before blank rows.
// Query: limit (default 50, max 200), offset|page, includeCleared=1 (audit view)
router.get('/incomplete-geography', async (req, res) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, { limit: 50, maxLimit: 200 });
    const includeCleared = req.query.includeCleared === '1' || req.query.includeCleared === 'true';
    const { rows, total, scannedCount, clearedCount } =
      await incompleteGeographyRows({ limit, offset, includeCleared });
    res.json({ rows, total, page, pages: Math.ceil(total / limit), scannedCount, clearedCount });
  } catch (error) {
    console.error('Incomplete-geography scan error:', error);
    res.status(500).json({ error: 'Failed to scan for incomplete geography' });
  }
});

// POST /api/admin/wines/incomplete-geography/clear — record that an admin read
// these wines and confirmed they legitimately have NO region (a country-wide
// designation, a multi-region blend), so the completeness queue stops
// surfacing them. DELETE undoes it. Body: { wineIds: [id, …] }.
//
// A THIRD parallel clearance endpoint rather than an extension of
// /cross-checks-clear, for the reason that one gives for not extending
// /verify-checks: each family's re-detect is its own, and dispatching them
// through one handler would tangle checks whose verdicts read different
// things. It writes to the SAME crossChecksCleared array — permitted by that
// field's invariant, since this verdict reads only region + appellation, both
// watched by the pre-validate hook, so filling either invalidates the
// clearance exactly as it should. Same gates as its siblings: bounded id
// list, server-side re-detect, $addToSet idempotence, no reindex (a clearance
// is not public content) and no MCP tool (a human's verdict asserted by an AI
// defeats the record).
router.post('/incomplete-geography/clear', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 1) return res.status(400).json({ error: 'wineIds must contain at least 1 valid id' });
    if (ids.length > 500) return res.status(400).json({ error: 'At most 500 wineIds per call' });

    const oids = ids.map(id => new mongoose.Types.ObjectId(id));
    const stillFlagged = await stillIncomplete(oids);
    if (stillFlagged.size === 0) return res.status(404).json({ error: 'No matching wines' });

    const now = new Date();
    const result = await WineDefinition.updateMany(
      { _id: { $in: [...stillFlagged].map(id => new mongoose.Types.ObjectId(id)) } },
      {
        $addToSet: { crossChecksCleared: GEOGRAPHY_INCOMPLETE_CHECK_ID },
        $set: { crossChecksClearedAt: now },
      }
    );
    logAudit(req, 'admin.wine.clearIncompleteGeography', { type: 'wine', id: ids[0] },
      { wineIds: ids, updated: result.modifiedCount || 0, notFlagged: ids.length - stillFlagged.size });
    res.json({
      message: 'Recorded',
      updated: result.modifiedCount || 0,
      notFlagged: ids.length - stillFlagged.size,
    });
  } catch (error) {
    console.error('Clear incomplete-geography error:', error);
    res.status(500).json({ error: 'Failed to record the clearance' });
  }
});

router.delete('/incomplete-geography/clear', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 1) return res.status(400).json({ error: 'wineIds must contain at least 1 valid id' });
    if (ids.length > 500) return res.status(400).json({ error: 'At most 500 wineIds per call' });

    const result = await WineDefinition.updateMany(
      { _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } },
      { $pull: { crossChecksCleared: GEOGRAPHY_INCOMPLETE_CHECK_ID } }
    );
    logAudit(req, 'admin.wine.unclearIncompleteGeography', { type: 'wine', id: ids[0] },
      { wineIds: ids, updated: result.modifiedCount || 0 });
    res.json({ message: 'Cleared', updated: result.modifiedCount || 0 });
  } catch (error) {
    console.error('Unclear incomplete-geography error:', error);
    res.status(500).json({ error: 'Failed to undo the clearance' });
  }
});

// POST /api/admin/wines/cross-checks-clear — record that an admin read these
// wines and confirmed the flagged values really belong in their fields, so
// the cross-field scan stops surfacing them FOR THOSE RULES ONLY. DELETE
// undoes it. Body: { wineIds: [id, …], checks: [ruleId, …] } (1..N ids).
//
// PARALLEL to /verify-checks rather than an extension of it, on purpose:
// that endpoint's whole contract (NAME_CHECK_SELECT projection, runNameChecks
// recompute, the verifiedChecks target) rests on the name+producer-only
// invariant this family deliberately breaks — dispatching both families
// through one handler would tangle the two invalidation records the model
// keeps apart. Same validation gates, same $addToSet idempotence, same
// no-reindex/no-IndexNow stance (a clearance is not public content), and the
// same no-MCP-tool rule: "a human checked this" asserted by an AI defeats
// the record.
router.post('/cross-checks-clear', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 1) return res.status(400).json({ error: 'wineIds must contain at least 1 valid id' });
    if (ids.length > 500) return res.status(400).json({ error: 'At most 500 wineIds per call' });

    const raw = Array.isArray(req.body?.checks) ? req.body.checks : null;
    const specs = (raw || []).map(resolveCrossFieldCheck);
    if (!raw || raw.length === 0 || specs.some(s => !s)) {
      return res.status(400).json({ error: 'checks must be a non-empty array of known check ids' });
    }
    const checkIds = [...new Set(specs.map(s => s.id))];

    // Server-side re-detect (mirrors /verify-checks): a stale client row must
    // not be able to clear a rule the admin never actually saw on screen.
    const hitsById = await detectCrossFieldForWines(ids.map(id => new mongoose.Types.ObjectId(id)), checkIds);
    if (hitsById.size === 0) return res.status(404).json({ error: 'No matching wines' });

    const now = new Date();
    const ops = [];
    const notFlagged = [];
    // Iterate the FOUND docs (map keys are canonical String(_id)), not the
    // client array — a case-variant id that the $in query matched must not
    // silently fall out of the clearance (same shape as /verify-checks).
    for (const [id, tripped] of hitsById) {
      if (tripped.length === 0) { notFlagged.push(id); continue; }
      ops.push({ updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(id) },
        update: {
          $addToSet: { crossChecksCleared: { $each: tripped } },
          $set: { crossChecksClearedAt: now },
        },
      } });
    }
    const result = ops.length ? await WineDefinition.bulkWrite(ops, { ordered: false }) : { modifiedCount: 0 };

    logAudit(req, 'admin.wine.clearCrossChecks', { type: 'wine', id: ids[0] },
      { wineIds: ids, checks: checkIds, updated: result.modifiedCount || 0, notFlagged: notFlagged.length });
    res.json({ message: 'Recorded', updated: result.modifiedCount || 0, checks: checkIds, notFlagged });
  } catch (error) {
    console.error('Clear cross-checks error:', error);
    res.status(500).json({ error: 'Failed to record clearance' });
  }
});

// DELETE /api/admin/wines/cross-checks-clear — undo the above.
// crossChecksClearedAt is deliberately left as-is: display/forensics
// metadata, not the suppression key (same contract as verifiedAt).
router.delete('/cross-checks-clear', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 1) return res.status(400).json({ error: 'wineIds must contain at least 1 valid id' });
    if (ids.length > 500) return res.status(400).json({ error: 'At most 500 wineIds per call' });

    const raw = Array.isArray(req.body?.checks) ? req.body.checks : null;
    const specs = (raw || []).map(resolveCrossFieldCheck);
    if (!raw || raw.length === 0 || specs.some(s => !s)) {
      return res.status(400).json({ error: 'checks must be a non-empty array of known check ids' });
    }
    const checkIds = [...new Set(specs.map(s => s.id))];

    const result = await WineDefinition.updateMany(
      { _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } },
      { $pull: { crossChecksCleared: { $in: checkIds } } }
    );
    logAudit(req, 'admin.wine.unclearCrossChecks', { type: 'wine', id: ids[0] },
      { wineIds: ids, checks: checkIds, updated: result.modifiedCount || 0 });
    res.json({ message: 'Clearance removed', updated: result.modifiedCount || 0 });
  } catch (error) {
    console.error('Unclear cross-checks error:', error);
    res.status(500).json({ error: 'Failed to remove clearance' });
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

    // Snapshot the profile-feeding fields BEFORE any mutation — the re-enrich
    // decision below compares against this, so only a REAL change (not the
    // form re-sending every field on save) regenerates the AI profile.
    const { profileInputsSnapshot, reenrichAfterRecordEdit } = require('../../services/enrichmentJob');
    const beforeProfileInputs = profileInputsSnapshot(wine);

    // Update fields
    if (name) wine.name = name.trim();
    if (producer) wine.producer = producer.trim();
    if (country) wine.country = country;
    if (region !== undefined) wine.region = region || null;
    if (appellation !== undefined) {
      wine.appellation = await resolveCanonicalAppellation(normalizeAppellation(appellation?.trim()));
    }
    if (grapes !== undefined) wine.grapes = grapes;
    if (type) wine.type = type;

    // Image handling. When the admin clears the default image, look for an
    // approved+public gallery image to promote in its place — otherwise the
    // wine ends up with no image even though candidates exist (the legacy
    // label-scan URL bug left wines in this state after Remove default image).
    if (image !== undefined) {
      if (image) {
        const imageErr = validateImageRef(image);
        if (imageErr) return res.status(400).json({ error: `Wine image: ${imageErr}` });
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
    // Compared before populate (the snapshot folds ids either way, but the
    // unpopulated doc is the apples-to-apples read).
    const profileInputsChanged = profileInputsSnapshot(wine) !== beforeProfileInputs;
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

    // An edit that changed any profile-feeding field (identity, geography,
    // classification, type, grapes) makes the AI profile a description of the
    // WRONG record — including a HELD one, whose whole point was "this
    // producer looks fictional": the admin just fixed exactly that.
    // Regenerate under the corrected record (fire-and-forget, no user budget
    // — a deliberate admin action). Real-change only: the v1.116.0 check was
    // presence-in-body, and the edit form re-sends every field on save, so it
    // would have regenerated (and churned generatedAt) on EVERY save. Curator
    // profiles are never touched; if the model still doubts the new identity
    // it simply holds again, which is the correct outcome.
    reenrichAfterRecordEdit(wine, profileInputsChanged);

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
      // Pending correction proposals on (or targeting) a deleted wine would
      // dangle in the review queue forever — same closure as performWineMerge.
      WineCorrectionProposal.updateMany(
        { status: 'pending', $or: [{ wineDefinition: id }, { mergeTargetId: id }] },
        { $set: { status: 'rejected', decidedAt: new Date(), rejectReason: 'Closed automatically: the wine was deleted before review.' } }
      ),
      // Active owner inquiries have nothing left to verify — same closure.
      closeInquiriesForWineDelete(id, req),
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

    const stripped = stripProducerName(wine.name, wine.producer)
      ?? stripProducerKeyPrefix(wine.name, wine.producer);
    if (!stripped) {
      return res.status(400).json({
        error: 'Wine name does not start or end with its producer, or nothing would remain after stripping'
      });
    }

    // If the same producer — under ANY spelling that shares the comparison key
    // ("Felton Road" vs "Felton Road Wines Ltd") — already has a wine with the
    // stripped name, renaming would just surface the very duplicate the
    // registry avoids: the admin should MERGE that pair via the duplicates
    // tool instead (the merge keeps bottles; a rename would collide).
    const producerKey = normalizeProducerKey(wine.producer);
    const nameTwins = await WineDefinition.find({
      _id: { $ne: wine._id },
      name: new RegExp(`^${escapeRegex(stripped)}$`, 'i'),
    }).select('name producer').limit(10).lean();
    const conflict = nameTwins.find(t => producerKey && normalizeProducerKey(t.producer) === producerKey);
    if (conflict) {
      return res.status(409).json({
        error: `"${conflict.name}" by ${conflict.producer} already exists — merge these via the duplicates tool instead.`,
        conflictId: conflict._id,
      });
    }

    const from = wine.name;
    wine.name = stripped;
    // Same denormalised-field maintenance as the PUT rename path: regenerate
    // the dedup key. The SLUG is regenerated by the model's save hook now that
    // the outgoing one is kept in previousSlugs — a slug stating a name the
    // wine no longer has was a second wrong record, and no existing URL breaks.
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

    const result = await performWineMerge(sourceId, targetId, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });

    res.json({
      message: 'Wines merged successfully',
      bottlesMoved: result.bottlesMoved,
      imageAction: result.imageAction,
    });
  } catch (error) {
    console.error('Merge wine error:', error);
    res.status(500).json({ error: 'Failed to merge wines' });
  }
});

// The single-pair merge body, extracted so the correction-proposal approve
// (routes/admin/wineProposals.js) runs EXACTLY the machinery the route above
// runs — one implementation, two callers. Ids must be pre-validated (24-hex,
// source ≠ target) by the caller. `req` is for audit attribution only.
// Returns { error: { status, message } } or { bottlesMoved, imageAction,
// source, target }.
async function performWineMerge(sourceId, targetId, req) {
  const [source, target] = await Promise.all([
    WineDefinition.findById(sourceId),
    WineDefinition.findById(targetId),
  ]);
  if (!source) return { error: { status: 404, message: 'Source wine not found' } };
  if (!target) return { error: { status: 404, message: 'Target wine not found' } };

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
  searchService.removeWine(String(sourceId));
  // Target was mutated if we adopted the image; re-index so search sees it
  if (imageAction === 'adopted_from_source') searchService.indexWine(targetId);

  // Close the source's PENDING correction proposals — a pending row whose
  // subject wine is gone would dangle forever: the review list renders a null
  // wine, approve 404s and reverts its claim back to pending, and the
  // AdminWines badge stays inflated (audit 2026-08-10 MED). Auto-reject with
  // the reason rather than re-point: the merge usually RESOLVES the complaint,
  // and silently re-targeting what an admin later approves would be spookier
  // than asking the somm to re-file against the keeper. decidedBy stays null —
  // this is lifecycle closure, not a reviewer's judgement.
  const keeperLabel = [target.producer, target.name].filter(Boolean).join(' — ');
  await WineCorrectionProposal.updateMany(
    { status: 'pending', $or: [{ wineDefinition: sourceId }, { mergeTargetId: sourceId }] },
    { $set: {
      status: 'rejected',
      decidedAt: new Date(),
      rejectReason: `Closed automatically: the wine was merged into "${keeperLabel}". Re-file against that wine if the issue still applies.`.slice(0, 500),
    } }
  );

  // Owner inquiries take the opposite path to proposals: the merge does NOT
  // resolve the question — the bottles (and their owners) moved to the keeper,
  // so active inquiries FOLLOW them. Only an open inquiry colliding with the
  // keeper's own open one closes (with the proposal-style reason).
  await repointInquiriesForWineMerge(sourceId, targetId, keeperLabel, req);

  // Re-embed the keeper's vintages (it just absorbed the source's bottles and
  // possibly its profile) so semantic search reflects the merged wine.
  reembedKeeper(targetId);

  return { bottlesMoved, imageAction, source, target };
}

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
    // Lifecycle parity with performWineMerge (audit 2026-08-11 M-2): pending
    // proposals close and owner inquiries follow the bottles on the GOLDEN
    // route too — reassignWineRefs deliberately owns only silent ref moves,
    // these two write user-visible outcomes (reject reasons, repoint audit).
    const goldenKeeperLabel = [keeper.producer, keeper.name].filter(Boolean).join(' — ');
    for (const src of sources) {
      bottlesMoved += await reassignWineRefs(src._id, keeperOid);
      await WineCorrectionProposal.updateMany(
        { status: 'pending', $or: [{ wineDefinition: src._id }, { mergeTargetId: src._id }] },
        {
          $set: {
            status: 'rejected',
            decidedAt: new Date(),
            rejectReason: `Closed automatically: the wine was merged into "${goldenKeeperLabel}". Re-file against that wine if the issue still applies.`.slice(0, 500),
          },
        }
      );
      await repointInquiriesForWineMerge(src._id, keeperOid, goldenKeeperLabel, req);
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
// The extracted single-pair merge, shared with the correction-proposal
// approve route (wineProposals.js) so the two surfaces cannot drift.
module.exports.performWineMerge = performWineMerge;
