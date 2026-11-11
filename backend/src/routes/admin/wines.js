const { splitPradikatFromAppellation } = require('../../utils/styleTerms');
const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const {
  generateWineKey, normalizeString, normalizeProducerKey, normalizeAppellation,
} = require('../../utils/normalize');
const { assignClassification } = require('../../services/classificationOps');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const { validateImageRef } = require('../../services/accountOps');
const { WINE_COLOURS, stateColour, colourTypeConflict } = require('../../utils/wineColour');
const { sameProducerAppellationGroups, nearProducerPairs, nameSubsetPairs } = require('../../services/registryFragmentation');
const {
  incompleteGeographyRows, stillIncomplete, GEOGRAPHY_INCOMPLETE_CHECK_ID,
} = require('../../services/registryCompleteness');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const BottleImage = require('../../models/BottleImage');
const DeletedBottle = require('../../models/DeletedBottle');
const WineVintageProfile = require('../../models/WineVintageProfile');
const WineVintagePrice = require('../../models/WineVintagePrice');
const WineReport = require('../../models/WineReport');
const Review = require('../../models/Review');
const Discussion = require('../../models/Discussion');
const DiscussionReply = require('../../models/DiscussionReply');
const WineNotDuplicate = require('../../models/WineNotDuplicate');
const { ensurePendingVintageProfile } = require('../../utils/vintageProfile');
// Pending correction proposals close with their wine THROUGH this service, so
// a user who filed one is told what happened (it owns the model access).
const { closePendingForWine } = require('../../services/wineCorrectionNotify');
const { settleNonWineProposals } = require('../../services/suggestionCred');
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
const PersonalDataEntry = require('../../models/PersonalDataEntry');
const RegistryDataValue = require('../../models/RegistryDataValue');
const { unlinkImageFiles } = require('../../services/imageProcessor');
const { reembedActiveVintages } = require('../../services/embeddingJob');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const { isValidId } = require('../../utils/validation');
const { escapeRegex } = require('../../utils/sanitize');
const { parsePagination } = require('../../utils/pagination');
const {
  REVIEW_QUEUE_OUTSTANDING_EXPR, isUndecidedPublishedSuspect, isOutstandingInReviewQueue,
} = require('../../utils/profileReview');
const { decideHeldProfile } = require('../../services/heldProfileOps');
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
// What follows a wine that is merged away (references, profile, vectors)
// lives in the service; this file keeps the two merge routes.
const {
  performWineMerge, purgeSourceVectors, inheritAiProfile, reembedKeeper, reassignWineRefs,
} = require('../../services/wineMergeOps');

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

        const wines = await WineDefinition.find({ _id: { $in: ids }, draft: { $ne: true } })
          .populate('country', 'name')
          .populate('region', 'name')
          .populate('grapes', 'name')
          .populate('classifications', 'name kind');

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
    const baseQuery = conditions.length === 0 ? {}
      : conditions.length === 1 ? conditions[0]
      : { $and: conditions };
    // Users' private drafts are not registry content, not even to an admin
    // (draft design 2026-09-12) — and this list would otherwise be the id
    // source for every other admin surface.
    const query = { ...baseQuery, draft: { $ne: true } };

    // When using $text, sort by relevance score first
    const mongoSort = search ? { score: { $meta: 'textScore' }, ...sortObj } : sortObj;

    const [wines, total] = await Promise.all([
      WineDefinition.find(query)
        .select(search ? { score: { $meta: 'textScore' } } : {})
        .populate('country', 'name')
        .populate('region', 'name')
        .populate('grapes', 'name')
        .populate('classifications', 'name kind')
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
    const { name, producer, country, region, appellation, grapes, type, colour, image, confirmCreate } = req.body;

    if (!name || !producer || !country) {
      return res.status(400).json({ error: 'Name, producer, and country are required' });
    }
    if (colour != null && colour !== '' && !WINE_COLOURS.includes(colour)) {
      return res.status(400).json({ error: `Colour must be one of: ${WINE_COLOURS.join(', ')}` });
    }
    {
      // Refused, not accepted-and-dropped by the model hook (audit 2026-09-19).
      const colourErr = colourTypeConflict(type || null, colour);
      if (colourErr) return res.status(400).json({ error: colourErr });
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
    // A bare Prädikat is not a place — same rule as findOrCreateWine (audit 2026-09-07).
    const pradikatSplit = splitPradikatFromAppellation(appellation, req.body.classification, cleanName);
    const cleanAppellation = await resolveCanonicalAppellation(
      normalizeAppellation(pradikatSplit.appellation)
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
    // has to be a real http(s) link or one of our own upload paths (audit
    // 2026-09 S7-1 / F06-1) — never an inline image (a picture is a file;
    // POST /:id/image uploads one).
    const imageErr = validateImageRef(image, { allowInline: false });
    if (imageErr) return res.status(400).json({ error: `Wine image: ${imageErr}` });

    // The write rule, strict for an admin (services/classificationOps): the
    // rows the picker chose, or a typed string resolved against the taxonomy;
    // a tier the taxonomy lacks is a 400 naming the known tiers.
    const classificationFields = {};
    const cls = await assignClassification(classificationFields, {
      classifications: req.body.classifications, classification: pradikatSplit.classification, countryId: country, strict: true,
    });
    if (!cls.ok) return res.status(400).json({ error: cls.message });

    const wine = new WineDefinition({
      name: cleanName,
      producer: producerToStore,
      country,
      region: region || null,
      appellation: cleanAppellation,
      ...classificationFields,
      grapes: grapes || [],
      type: type || null, // no guessed red
      // Kept only on a sparkling/dessert/fortified wine — the model hook drops
      // it otherwise, and fills it from a rosé name when none is given.
      colour: colour || null,
      image: image || null,
      normalizedKey,
      createdBy: req.user.id,
      createdVia: 'ui'
    });

    await wine.save();
    await wine.populate(['country', 'region', 'grapes', { path: 'classifications', select: 'name kind' }]);

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
    const wine = await WineDefinition.findById(req.params.id).select('_id name producer draft');
    // A user's private draft is not registry content, not even to an admin.
    if (!wine || wine.draft === true) return res.status(404).json({ error: 'Wine not found' });

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

// The duplicate queues have their own file. Mounted here, behind the admin
// gate above and BEFORE the /:id routes: Express would otherwise read
// "duplicates" as a wine id.
router.use(require('./wineDuplicates'));

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
    // A user's private draft is not registry content, not even to an admin.
    if (!wine || wine.draft === true) return res.status(404).json({ error: 'Wine not found' });

    const wasNonWine = wine.nonWine === true;
    wine.nonWine = req.body.value;
    await wine.save();
    // Self-healing index sync: indexWine removes flagged rows, re-adds restored ones.
    searchService.indexWine(wine._id);
    // The vectors too: a quarantined row's embeddings would keep it in
    // semantic search and the similar-wines graph (audit 2026-10-14). A
    // restore re-embeds the vintages in cellars, as a promotion does.
    if (req.body.value === true) await purgeSourceVectors(wine._id);
    else if (wasNonWine) reembedActiveVintages(wine._id).catch(() => {});

    // Completes the quarantine for the somm queue, the same rule as the
    // proposal path's non_wine apply: PENDING maturity rows go (auto-seeded
    // stubs); REVIEWED windows are curated data and stay with the record.
    let pendingRemoved = 0;
    if (req.body.value === true && !wasNonWine) {
      const del = await WineVintageProfile.deleteMany({ wineDefinition: wine._id, status: 'pending' });
      pendingRemoved = del.deletedCount || 0;
    }

    // A restore gives back the maturity-queue rows the quarantine removed
    // (both quarantine paths delete the PENDING ones), seeded from
    // the bottles in cellars — the same re-seed a pending wine gets when it
    // is promoted. Bottles on order are queued when they arrive.
    if (wasNonWine && req.body.value === false) {
      try {
        const vintages = await Bottle.distinct('vintage', { wineDefinition: wine._id, status: 'active' });
        for (const v of vintages) await ensurePendingVintageProfile(wine._id, v);
      } catch (err) {
        console.warn('Maturity re-seed after a non-wine restore failed (non-fatal):', err.message);
      }
    }

    // An approved non-wine proposal earns its proposer while the wine stays in
    // the quarantine: a restore (the undo of an applied flag) takes that Cellar
    // Cred back, quarantining the wine again gives it back. Never throws.
    if (wine.nonWine !== wasNonWine) await settleNonWineProposals(wine._id, wine.nonWine === true);

    logAudit(req, 'admin.wine.nonWine', { type: 'wine', id: wine._id },
      { value: req.body.value, name: wine.name, producer: wine.producer, ...(req.body.value === true ? { pendingRemoved } : {}) });
    res.json({ message: req.body.value ? 'Quarantined as non-wine' : 'Restored as wine', nonWine: wine.nonWine });
  } catch (error) {
    console.error('Non-wine toggle error:', error);
    res.status(500).json({ error: 'Failed to update non-wine flag' });
  }
});

// POST /api/admin/wines/:id/profile-reviewed — record that an admin read this
// low-confidence wine and judged its data correct as of the CURRENT profile.
// DELETE undoes the stamp. Self-invalidating by timestamp comparison (see GET
// above), so there is nothing to clear on later edits. On a published profile
// whose producer is flagged, "correct" is a verdict on the flag and is
// recorded as one (below); DELETE does not bring a cleared flag back.
router.post('/:id/profile-reviewed', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wine = await WineDefinition.findById(req.params.id)
      .select('name producer aiProfile.heldAt aiProfile.producerSuspect aiProfile.description aiProfile.suspectDecision draft');
    if (!wine || wine.draft === true) return res.status(404).json({ error: 'Wine not found' });

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
      // Somm-owned wine data (enrichmentOnAdd 'off', 2026-08-22): the AI writes
      // no profile, and a release is a forced regeneration. Refused with the
      // way out — writing the profile by hand replaces the held one and clears
      // the hold (services/wineProfileOps.applyProfilePatch). The MCP twin,
      // review_held_profile, refuses the same way.
      if (require('../../config/aiConfig').get().enrichmentOnAdd === 'off') {
        return res.status(409).json({
          error: 'Automatic AI profiles are switched off (SuperAdmin → AI Spend Controls), so a held profile is not regenerated. Write the profile by hand instead — that replaces the held one and clears the hold.',
        });
      }
      const { releaseHeldProfile } = require('../../services/enrichmentJob');
      releaseHeldProfile(wine._id).catch(() => {});
      logAudit(req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
        { name: wine.name, producer: wine.producer, heldRelease: true });
      return res.json({ message: 'Publishing the held profile', profileReviewedAt: null });
    }

    // A PUBLISHED profile whose producer is flagged: "this data is correct"
    // answers the flag, so it is recorded as the confirm the curator's
    // review_held_profile gives (services/heldProfileOps). The flag and the
    // caveat owners see go, the verdict stays on the row, the model's note
    // moves into the audit row, and the wine is done in both queues. A stamp
    // alone left the caveat on the wine and the row in the curator's queue.
    if (isUndecidedPublishedSuspect(wine.aiProfile)) {
      const decided = await decideHeldProfile(String(wine._id), 'confirm', { req });
      if (decided.error) {
        return res.status(decided.error === 'not_found' ? 404 : 409).json({
          error: decided.error === 'not_found' ? 'Wine not found' : 'This wine changed while it was being reviewed — reload the list.',
        });
      }
      return res.json({ message: 'Marked reviewed', profileReviewedAt: decided.reviewed_at, suspectCleared: true });
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
// by comparison alone. A published profile with a flagged producer stays
// until someone rules on the flag, whatever its stamp says (the curator
// queue's rule, utils/profileReview). ?includeReviewed=1 is the audit view,
// and each row says whether it is `reviewed` by that same rule. Sorted most
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
        // confidence — a flagged row can sit above the default threshold, and
        // a confidence filter alone would never surface the very row the flag
        // exists for. Suspect rows appear regardless of threshold, and
        // their profiles are HELD unpublished until someone in this queue
        // decides.
        //
        // This branch means what it says: the
        // producer FIELD looks wrong. producerUnknown ("a real winery name I
        // cannot place") is deliberately NOT a branch here — it describes most
        // small estates in the registry and is not review work, so listing it
        // would bury the rows that are genuinely wrong. It rides on each row
        // for context instead.
        { 'aiProfile.producerSuspect': true },
        // Every HELD row surfaces regardless of threshold (the publication
        // gate): an unknown-producer hold can sit at 0.5 —
        // above the default threshold with no suspect flag — and this queue
        // is the only place a hold gets released. heldReason says why.
        { 'aiProfile.heldAt': { $ne: null } },
      ],
      // Only rows that were actually enriched — without this, every wine that
      // has no aiProfile at all would match the null branch above.
      'aiProfile.generatedAt': { $ne: null },
    };
    const outstanding = { ...base, $expr: REVIEW_QUEUE_OUTSTANDING_EXPR };

    const filter = includeReviewed ? base : outstanding;
    const [rows, total, reviewedCount] = await Promise.all([
      WineDefinition.find(filter)
        .select('name producer appellation nonWine profileReviewedAt aiProfile.confidence aiProfile.description aiProfile.producerSuspect aiProfile.producerUnknown aiProfile.producerNote aiProfile.generatedAt aiProfile.heldAt aiProfile.heldReason aiProfile.suspectDecision')
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
        // By the queue's own rule, so the page does not derive it from the
        // two timestamps: a flagged producer nobody ruled on is not reviewed.
        reviewed: !isOutstandingInReviewQueue(w),
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
      .populate('grapes', 'name')
      .populate('classifications', 'name kind');
    // A user's private draft is not registry content, not even to an admin —
    // the same not-found a missing id gets (draft design 2026-09-12).
    if (wine && wine.draft === true) return res.status(404).json({ error: 'Wine not found' });
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
    const { name, producer, country, region, appellation, classification, classifications, grapes, type, colour, image } = req.body;

    const wine = await WineDefinition.findById(req.params.id);
    // A private draft is not registry content, not even to an admin (draft design 2026-09-12).
    if (!wine || wine.draft === true) {
      return res.status(404).json({ error: 'Wine not found' });
    }
    if (colour != null && colour !== '' && !WINE_COLOURS.includes(colour)) {
      return res.status(400).json({ error: `Colour must be one of: ${WINE_COLOURS.join(', ')}` });
    }
    {
      // Judged against the type this save leaves the wine with.
      const colourErr = colourTypeConflict(type || wine.type, colour);
      if (colourErr) return res.status(400).json({ error: colourErr });
    }
    // The create route's input checks, before anything is changed: a bad id or
    // a non-string field is a 400, not a cast error turned into a 500.
    if ((name != null && typeof name !== 'string') || (producer != null && typeof producer !== 'string')) {
      return res.status(400).json({ error: 'Name and producer must be strings' });
    }
    if (appellation != null && typeof appellation !== 'string') {
      return res.status(400).json({ error: 'Appellation must be a string' });
    }
    if (classification != null && typeof classification !== 'string') {
      return res.status(400).json({ error: 'Classification must be a string' });
    }
    if (classifications != null && !Array.isArray(classifications)) {
      return res.status(400).json({ error: 'Classifications must be a list' });
    }
    if (country && !isValidId(String(country))) {
      return res.status(400).json({ error: 'Invalid country' });
    }
    if (region && !isValidId(String(region))) {
      return res.status(400).json({ error: 'Invalid region' });
    }
    if (grapes !== undefined && (!Array.isArray(grapes) || !grapes.every((g) => isValidId(String(g))))) {
      return res.status(400).json({ error: 'Invalid grapes' });
    }
    // A bare Prädikat is not a place. Create (built for scans) moves it into
    // the classification; an edit is a person at a form, so it is refused
    // rather than moved behind their back. Only when the appellation CHANGES:
    // the form re-sends every field, and an older row stored with one must
    // stay editable (and mergeable from the cluster modal).
    if (appellation && appellation.trim() && appellation.trim() !== (wine.appellation || '')
      && splitPradikatFromAppellation(appellation, null, '').appellation === null) {
      return res.status(400).json({
        error: `"${appellation.trim()}" is a Prädikat (ripeness level), not an appellation — a bare Prädikat is never stored as the appellation`,
      });
    }
    const nextAppellation = appellation !== undefined
      ? await resolveCanonicalAppellation(normalizeAppellation(appellation?.trim()))
      : wine.appellation;

    // Name and producer: the same step-0 canon and producer gate as create,
    // each run only when its own field really changes (the edit form re-sends
    // every field on save, so an unrelated save never renames or blocks an old
    // row): the canon on a name change, the producer gate on a producer change.
    // No producer-spelling resolve: that would undo a curator's deliberate rename.
    const typedName = name && name.trim() ? name.trim() : wine.name;
    const nextProducer = producer && producer.trim() ? producer.trim() : wine.producer;
    const nextName = typedName !== wine.name
      ? (canonicalizeWineName(typedName, nextProducer) || typedName)
      : wine.name;
    if (nextProducer !== wine.producer) {
      const { detectBlockingProducerIssue } = require('../../services/crossFieldScan');
      const blocked = await detectBlockingProducerIssue({ name: nextName, producer: nextProducer, appellation: nextAppellation || '' });
      if (blocked) {
        return res.status(400).json({
          error: `"${nextProducer}" is not a usable producer name — cross-field rule ${blocked.check} matched "${blocked.detail}", which belongs in a different field`,
        });
      }
    }

    // Snapshot the profile-feeding fields BEFORE any mutation — the re-enrich
    // decision below compares against this, so only a REAL change (not the
    // form re-sending every field on save) regenerates the AI profile.
    const { profileInputsSnapshot, reenrichAfterRecordEdit } = require('../../services/enrichmentJob');
    const beforeProfileInputs = profileInputsSnapshot(wine);

    // Update fields
    wine.name = nextName;
    wine.producer = nextProducer;
    if (country) wine.country = country;
    if (region !== undefined) wine.region = region || null;
    if (appellation !== undefined) wine.appellation = nextAppellation;
    // Absent = leave alone; '' or null = clear. Normalised the way the mint
    // does it (a regulatory mark stores as no classification), and a change
    // feeds the re-enrich decision below like any other profile input.
    // The write rule, strict for an admin (services/classificationOps): the
    // rows the picker chose, or a typed string resolved against the taxonomy;
    // a tier the taxonomy lacks is a 400 naming the known tiers. Absent =
    // leave alone; '' / null / [] = clear.
    if (classifications !== undefined || classification !== undefined) {
      const cls = await assignClassification(wine, {
        classifications: classifications === null ? [] : classifications, classification, countryId: country || undefined, strict: true,
      });
      if (!cls.ok) return res.status(400).json({ error: cls.message });
    }
    if (grapes !== undefined) wine.grapes = grapes;
    if (type) wine.type = type;
    // Absent = leave alone; '' or null = clear. The model hook drops it again
    // if the (possibly new) type is itself a colour.
    // stateColour: an explicit "not stated" sent with a retype must not be
    // re-inferred from the name by the model hook.
    if (colour !== undefined) stateColour(wine, colour);

    // Image handling. When the admin clears the default image, look for an
    // approved+public gallery image to promote in its place — otherwise the
    // wine ends up with no image even though candidates exist (the legacy
    // label-scan URL bug left wines in this state after Remove default image).
    if (image !== undefined) {
      if (image) {
        // A new picture is never stored inline. An unchanged one passes, so an
        // unrelated edit of a wine still holding an inline picture from before
        // works (scripts/convert-inline-wine-images.js converts those).
        const imageErr = validateImageRef(image, { allowInline: image === wine.image });
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
    await wine.populate(['country', 'region', 'grapes', { path: 'classifications', select: 'name kind' }]);

    // Sync to the registry index (fire-and-forget). Cellar search
    // (services/bottleSearch) reads the wine live from MongoDB.
    searchService.indexWine(wine._id);

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
// recommendations, members' wine-level personal data entries) — deleting
// under those would orphan or silently vanish other people's data; merge
// re-points references and is the right tool.
// Registry-side/derived data that only exists FOR the wine (maturity
// profiles, price snapshots/opt-ins, community prices, embeddings with their
// vectors, restock alerts, reports, registry data values) is cascade-deleted
// with it.
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wine = await WineDefinition.findById(req.params.id);
    // A private draft is not registry content, not even to an admin (draft design 2026-09-12).
    if (!wine || wine.draft === true) {
      return res.status(404).json({ error: 'Wine not found' });
    }
    const id = wine._id;

    const [bottles, recentlyDeletedBottles, wishlistItems, reviews, discussions, discussionReplies, journalEntries, wineLists, recommendations, personalDataEntries] = await Promise.all([
      Bottle.countDocuments({ wineDefinition: id }),
      // Bottles in a "Recently deleted" (services/bottleTrash) can still be
      // restored onto this wine; a merge re-points them, a delete would strand them.
      DeletedBottle.countDocuments({ wineDefinition: id }),
      WishlistItem.countDocuments({ wineDefinition: id }),
      Review.countDocuments({ wineDefinition: id }),
      Discussion.countDocuments({ wineDefinition: id }),
      DiscussionReply.countDocuments({ wineDefinition: id }),
      JournalEntry.countDocuments({ 'pairings.wine': id }),
      WineList.countDocuments({ $or: [{ 'sections.entries.wine': id }, { 'autoGroupEntries.wine': id }] }),
      Recommendation.countDocuments({ wine: id }),
      // A member's own typed entries on the wine (bottle-level entries carry
      // no wine ref and follow their bottle).
      PersonalDataEntry.countDocuments({ wineDefinition: id }),
    ]);
    const references = { bottles, recentlyDeletedBottles, wishlistItems, reviews, discussions, discussionReplies, journalEntries, wineLists, recommendations, personalDataEntries };
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
      // Registry data values (suggested, published, rejected) describe only
      // this wine; nothing can read or review them once it is gone.
      RegistryDataValue.deleteMany({ wineDefinition: id }),
      // Pending correction proposals on (or targeting) a deleted wine would
      // dangle in the review queue forever — same closure as performWineMerge.
      // Through the shared closer, so a user who filed one is told (the wine is
      // gone, so the notification has nowhere to link).
      closePendingForWine(id, 'Closed automatically: the wine was deleted before review.',
        { wine, actorId: req.user?.id }),
      // Active owner inquiries have nothing left to verify — same closure.
      closeInquiriesForWineDelete(id, req),
      // WineEmbedding rows, which hold the vectors (same helper as merge).
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
    // A private draft is not registry content, not even to an admin (draft design 2026-09-12).
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

// POST /api/admin/wines/:id/merge - Merge source wine into target, reassign all references, then delete source
router.post('/:id/merge', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { targetId } = req.body;
    const sourceId = req.params.id;

    if (!isValidId(targetId)) {
      return res.status(400).json({ error: 'A valid targetId is required' });
    }
    // Compare canonical forms: an id in another letter case names the same
    // wine (MongoDB casts both to one ObjectId).
    if (sourceId.toLowerCase() === targetId.toLowerCase()) {
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
    // Canonical (lower-case) ids, so a source spelled in another letter case
    // dedupes and the keeper is left out whatever its spelling.
    const keeperCanon = keeperId.toLowerCase();
    const ids = [...new Set(sourceIds.filter(id => isValidId(id)).map(id => id.toLowerCase()))]
      .filter(id => id !== keeperCanon);
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

    // A private draft takes no part in a merge, as in performWineMerge: a
    // draft keeper answers like a missing one, and a draft among the sources
    // is left out while the rest of the cluster merges.
    const keeper = await WineDefinition.findById(keeperOid);
    if (!keeper || keeper.draft === true) return res.status(404).json({ error: 'Keeper wine not found' });
    const sources = await WineDefinition.find({ _id: { $in: sourceOids }, draft: { $ne: true } });
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
      await closePendingForWine(
        src._id,
        `Closed automatically: the wine was merged into "${goldenKeeperLabel}". Re-file against that wine if the issue still applies.`.slice(0, 500),
        { wine: src, linkWineId: keeperOid, actorId: req.user?.id }
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

    // Carry the best source tasting profile to the keeper when it has none, or
    // when only a source's was reviewed by a curator — so the re-embed below
    // encodes taste/style instead of losing it on merge.
    await inheritAiProfile(keeper, sources);

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
