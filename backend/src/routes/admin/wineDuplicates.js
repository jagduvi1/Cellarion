// The admin duplicate queues: the registry-wide cluster scan, the standing
// queue of wines that share a canonical key, the look-up of wines that
// resemble a name and producer, and the "not duplicates" verdict that keeps a
// set of wines out of the scans. Mounted by routes/admin/wines.js, behind its
// admin gate.

const express = require('express');
const mongoose = require('mongoose');
const {
  calculateSimilarity, combinedSimilarity, trigramSimilarity, tokenSimilarity, normalizeProducerKey,
} = require('../../utils/normalize');
const { scoreWineMatch } = require('../../services/wineMatching');
const { conflictingStyleTerms } = require('../../utils/styleTerms');
const WineDefinition = require('../../models/WineDefinition');
const { bottleCountsByWine } = require('../../services/wineUsage');
const { loadNotDuplicates, markNotDuplicates, unmarkNotDuplicates } = require('../../services/notDuplicateStore');
const { logAudit } = require('../../services/audit');
const { isValidId, coerceStringQuery } = require('../../utils/validation');
const { escapeRegex } = require('../../utils/sanitize');

const router = express.Router();

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
    // merge candidate against a wine.
    const wines = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
      // labelSweetness rides along, populated: the style guard below reads a
      // row's recorded term, not only its name (utils/styleTerms.styleOf).
      .select('name producer appellation image type colour country region labelSweetness')
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('labelSweetness', 'name band scale regulated -_id')
      .lean();

    // Group by normalised producer KEY: wine stop words + corporate suffixes
    // stripped, so "Kumeu River Wines Limited" and "Kumeu River" land in the
    // same bucket and the pairwise scorer + merge UI can surface them.
    // Bucketing only ever MERGES buckets (fewer distinct keys), never
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
    // they stop resurfacing on every scan.
    const dismissed = await loadNotDuplicates();

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
          if (dismissed.has(aId, bId)) continue; // admin marked these as not duplicates
          // Names stating a DIFFERENT Prädikat/sweetness are a producer's
          // range, not duplicates: a Mosel estate's whole
          // range scores 0.83–0.90 pairwise, far above the default 0.6 floor,
          // and would cluster as the scan's top proposal — one admin merge
          // from collapsing every user's bottles across it. Same shape as
          // the dismissed-edge skip above, and reject-only like every other
          // consumer of this guard: it can only drop a proposed merge, never
          // propose one, and it spares the n² manual dismissals a surfaced
          // range would otherwise cost.
          if (conflictingStyleTerms(a, b)) continue;
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
    const bottleCounts = await bottleCountsByWine(allClusterWineIds.map(id => new mongoose.Types.ObjectId(id)));

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

// POST /api/admin/wines/dismiss-duplicates — mark a cluster's wines as NOT the
// same wine. Records every pair so the duplicate scanner stops surfacing them.
// Body: { wineIds: [id, id, ...] } (the cluster's wine ids)
router.post('/dismiss-duplicates', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.wineIds) ? req.body.wineIds : []).filter(isValidId))];
    if (ids.length < 2) {
      return res.status(400).json({ error: 'wineIds must contain at least 2 valid, distinct ids' });
    }
    const pairsRecorded = await markNotDuplicates(ids);
    logAudit(req, 'admin.wine.dismissDuplicates', { type: 'wine', id: ids[0] }, { wineIds: ids, pairs: pairsRecorded });
    res.json({ message: 'Marked as not duplicates', pairsRecorded });
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
    const pairsRemoved = await unmarkNotDuplicates(ids);
    logAudit(req, 'admin.wine.undismissDuplicates', { type: 'wine', id: ids[0] }, { wineIds: ids });
    res.json({ message: 'Restored', pairsRemoved });
  } catch (error) {
    console.error('Undismiss duplicates error:', error);
    res.status(500).json({ error: 'Failed to restore' });
  }
});

// GET /api/admin/wines/duplicates — wines that resemble a name and producer,
// asked when a wine request is reviewed, before the wine is created.
// Query: name, producer (both required), appellation, threshold (default 0.75)
router.get('/duplicates', async (req, res) => {
  try {
    // A repeated query param arrives as an array: coerced to '' it hits the 400
    // below instead of a .split() TypeError (500).
    const name = coerceStringQuery(req.query.name);
    const producer = coerceStringQuery(req.query.producer);
    const appellation = coerceStringQuery(req.query.appellation) || undefined;
    const parsedThreshold = parseFloat(coerceStringQuery(req.query.threshold));
    const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 0.75;

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
    // the other duplicate pools.
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

        // Overall: the shared scorer every add flow uses (producer keys,
        // star grades, label abbreviations). The breakdown above stays as
        // the per-algorithm detail.
        const overallSimilarity = scoreWineMatch(wine, { name, producer, appellation }, { redistribute: false });

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
      .filter(item => item.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);

    res.json({
      count: candidates.length,
      threshold,
      query: { name, producer, appellation },
      candidates
    });
  } catch (error) {
    console.error('Find duplicates error:', error);
    res.status(500).json({ error: 'Failed to find duplicates' });
  }
});

// GET /api/admin/wines/canonical-collisions — the standing duplicate queue.
// Groups wines by canonicalKey; every
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
    const dismissed = await loadNotDuplicates();
    const active = collisions.filter(([, arr]) => {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (!dismissed.has(arr[i]._id, arr[j]._id)) return true;
        }
      }
      return false;
    });

    const ids = active.flatMap(([, arr]) => arr.map(w => w._id));
    const bottleCounts = await bottleCountsByWine(ids);

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

module.exports = router;
