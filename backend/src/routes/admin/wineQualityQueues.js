// The admin data-quality queues: scans that list the wines whose record trips
// a rule, and the clearances by which an admin records "I read it, it is right".
//   name checks         GET /producer-in-name, POST|DELETE /verify-checks,
//                       POST /:id/strip-producer
//   fragmentation       GET /fragmentation
//   cross-field checks  GET /cross-field-checks, POST|DELETE /cross-checks-clear
//   completeness        GET /incomplete-geography, POST|DELETE /incomplete-geography/clear
// Mounted by routes/admin/wines.js, behind its admin gate.

const express = require('express');
const mongoose = require('mongoose');
const { generateWineKey, normalizeProducerKey } = require('../../utils/normalize');
const {
  sameProducerAppellationGroups, nearProducerPairs, nameSubsetPairs,
} = require('../../services/registryFragmentation');
const {
  incompleteGeographyRows, stillIncomplete, GEOGRAPHY_INCOMPLETE_CHECK_ID,
} = require('../../services/registryCompleteness');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const { isValidId } = require('../../utils/validation');
const { escapeRegex } = require('../../utils/sanitize');
const { parsePagination } = require('../../utils/pagination');
const { stripProducerName, stripProducerKeyPrefix } = require('../../utils/producerPrefix');
const {
  NAME_CHECKS, NAME_CHECK_IDS, DEFAULT_CHECK_IDS, NAME_CHECK_SELECT, resolveCheck, runNameChecks,
} = require('../../utils/nameChecks');
const {
  CROSS_FIELD_CHECK_IDS, DEFAULT_CROSS_FIELD_CHECK_IDS, CROSS_FIELD_CHECK_LABEL_KEYS,
  CROSS_FIELD_CHECK_FIELDS, resolveCrossFieldCheck,
} = require('../../utils/crossFieldChecks');
const { scanCrossFieldChecks, detectCrossFieldForWines } = require('../../services/crossFieldScan');

const router = express.Router();

// GET /api/admin/wines/producer-in-name — the registry NAME-CHECK scan. The
// path keeps its historical name (a rename churns working i18n keys and a
// live client for zero functional gain) but it now runs every defaultActive
// rule in utils/nameChecks.js:
//   producer-in-name.v1        — name starts/ends with its own producer,
//                                including key-token variants ("Felton Road
//                                Block 3 Pinot Noir" / "Felton Road Wines Ltd")
//   dangling-name-tail.v3      — name ends in a stranded connective
//                                ("La Viña de")
//   name-equals-producer.v1    — name === producer, non-estate shape
// plus the non-default estate cohort via ?check=name-equals-producer-estate.v1.
//
// Query params:
//   ?check=<ruleId>      scope to one rule (default = every defaultActive rule)
//   ?includeVerified=1   AUDIT VIEW — ignore clearances entirely, so a newly
//                        added or refined rule can be validated against
//                        every row before its suppression is trusted
//
// Rows an admin cleared via POST /verify-checks are suppressed PER RULE. The
// key-token check has no aggregation mirror, so the scan runs in Node — same
// full-fetch pattern (and cost) as the duplicate-clusters scan
// (routes/admin/wineDuplicates.js), fine at
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

// POST /api/admin/wines/:id/strip-producer — remove the wine's own producer
// (prefix OR suffix) from its name (companion to GET /producer-in-name).
// Recomputes the check server-side so a stale client row can't rename
// arbitrarily.
router.post('/:id/strip-producer', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wine = await WineDefinition.findById(req.params.id);
    // A private draft is not registry content, not even to an admin.
    if (!wine || wine.draft === true) {
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
    }).select('name producer labelSweetness').limit(10).lean();
    // Same producer AND the same label sweetness term (term-or-none, by row):
    // a termed wine and its untermed twin — or two different terms — are two
    // wines, not a pair the admin should merge. No wildcard here.
    const sameTerm = (t) => String(t.labelSweetness || '') === String(wine.labelSweetness || '');
    const conflict = nameTwins.find(t => producerKey && normalizeProducerKey(t.producer) === producerKey && sameTerm(t));
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
    await wine.populate(['country', 'region', 'grapes', { path: 'classifications', select: 'name kind' }]);

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

// GET /api/admin/wines/fragmentation?mode=groups|pairs — SAME-WINE
// fragmentation the name-keyed nets cannot see:
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
      // Short-vs-full name fragments within one producer (e.g.
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

// GET /api/admin/wines/cross-field-checks — the CROSS-FIELD domain scan:
// registry values sitting in the wrong FIELD, tested against the reference lists the app already holds
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
// net keys off a value, so a region-less row trips nothing and sits invisible.
// Sorted most-owned first, appellation leads before blank rows.
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

module.exports = router;
