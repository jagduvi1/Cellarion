const express = require('express');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Discussion = require('../models/Discussion');
const searchService = require('../services/search');
const { requireAuth, requireNonDemo, optionalAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const rateLimitsConfig = require('../config/rateLimits');
const { rateLimitKey } = require('../utils/clientIp');
const { logAudit } = require('../services/audit');
const { scanLabelFull, scanLabelBack, mergeBackScan, identifyWineFromQuery } = require('../services/labelScan');
const { sanitizeImageBuffer, detectImageFormat } = require('../services/imageSanitizer');
const { persistLabelScan } = require('../services/imageOps');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { generateWineKey } = require('../utils/normalize');
const { findBestMatch } = require('../services/wineMatching');
const { parsePagination } = require('../utils/pagination');
const { isValidId } = require('../utils/validation');
// Read-surface decoration: each populated grape gains `displayName` — the
// regionally correct label for THIS wine (Tinta Roriz on a Douro Port) —
// while `name` stays canonical. Storage/filters/stats are untouched.
const { decorateGrapes } = require('../utils/grapeDisplay');
const { getReleaseCurve } = require('../services/communityPrice');
const aiBurstLimiter = require('../middleware/aiBurstLimiter');
const asyncHandler = require('../utils/asyncHandler');
const { tryDebitAi, isRefundableFailure, isRefundableScanError } = require('../services/aiBudget');

const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';

const router = express.Router();

// Cap the free-text AI query length before it becomes Claude prompt input, so a
// caller can't maximize per-call input-token cost with a ~10KB body. Mirrors the
// chat message cap (chat.js).
const MAX_AI_QUERY_LEN = 300;

// Field caps shared with the registry-write path (which now lives at bottle/
// wishlist commit — services/wineCommit). Imported, not re-declared, so the
// resolve endpoint below and the commit endpoints can never drift.
const { validateNewWineFields, MAX_WINE_FIELD, MAX_GRAPES } = require('../services/wineCommit');
const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

/**
 * Mark a scan whose PRODUCER is detectably not a producer.
 *
 * Prod 2026-08-13: a label scan returned producer "Pays d'Oc Organic Wine",
 * name "Chardonnay Reserve". Both boxes were filled, so the extraction looked
 * complete, the read-only confirmation card was shown, the user pressed
 * confirm, and the registry gained a published wine whose producer is a
 * region-plus-marketing-copy string. Nothing asked whether the string was a
 * producer.
 *
 * The same six rules the mint chokepoint and the curation queue use
 * (services/crossFieldScan.detectBlockingProducerIssue), applied to the
 * EXTRACTION. A hit reuses the v1.109.0 half-read machinery verbatim —
 * `partial: true` routes the client to the editable prefilled form plus the
 * back-label offer — so the user gets a chance to fix the producer BEFORE
 * committing, with no new step and nothing rejected. `producer_suspect` names
 * the rule, so the response says WHY rather than just "partial".
 *
 * Best-effort: this is a decoration on a scan that has already been paid for,
 * and a taxonomy read failing here must never turn a successful scan into an
 * error. Mutates and returns the extraction it was given.
 */
async function flagSuspectProducer(extracted, { match = null } = {}) {
  if (!extracted || typeof extracted !== 'object') return extracted;
  if (typeof extracted.producer !== 'string' || !extracted.producer.trim()) return extracted;
  try {
    const { detectScanSuspectProducer } = require('../services/crossFieldScan');
    // Field caps BEFORE the check (release-audit HIGH-2): scanLabelFull hands
    // back the model's raw JSON, so a crafted label can return a producer far
    // past any schema cap — and the containment heuristic's cost grows with
    // token count. 200 chars is the registry field cap; nothing real is longer.
    const hit = await detectScanSuspectProducer({
      name: typeof extracted.name === 'string' ? extracted.name.slice(0, 200) : '',
      producer: extracted.producer.slice(0, 200),
      appellation: typeof extracted.appellation === 'string' ? extracted.appellation.slice(0, 200) : '',
    });
    if (!hit) return extracted;
    // Flag ONLY when the registry matched nothing — for hard and soft hits
    // alike (release-audit M-3). With a match present, confirming attaches to
    // the EXISTING wine and mints nothing, so the flag would cost the one-tap
    // card (and the manual form's country requirement) for zero registry
    // benefit; a real place-named estate — Château Margaux — keeps its card
    // (the #942 lesson). A junk producer that matches an existing junk row
    // dedups to it, which beats minting a twin; that row is curation's to fix.
    // Without a match, the flag routes to the editable form, and if the user
    // confirms a HARD-hit producer unchanged the mint gate files it pending.
    if (!match) {
      extracted.partial = true;
      extracted.producer_suspect = hit.check;
    }
  } catch (err) {
    console.warn('Producer cross-field check failed (non-fatal):', err.message);
  }
  return extracted;
}

const cleanField = (v) => {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ').slice(0, MAX_WINE_FIELD);
  return s || null;
};

/**
 * Normalize + allowlist the model's identification before it leaves the route.
 *
 * identify-text returns this to the client UNSAVED (the user confirms before
 * anything is written), so it is the last place the shape is guaranteed. Two
 * jobs: keep the payload inside the same caps findOrCreateWine would apply, and
 * make the match-only probe throw-free — findOrCreateWine calls .trim() on
 * name/producer before consulting any option, and labelScan's identity check
 * only tests truthiness, so a model that returns `"name": 42` would otherwise
 * 500 inside the probe.
 *
 * @returns {object|null} null when name or producer is unusable — the caller
 *   reports that as "not identified" rather than probing with junk.
 */
function normalizeIdentifiedWine(data) {
  if (!data || typeof data !== 'object') return null;

  const name = cleanField(data.name);
  const producer = cleanField(data.producer);
  if (!name || !producer) return null;

  const grapes = Array.isArray(data.grapes)
    ? data.grapes.map(cleanField).filter(Boolean).slice(0, MAX_GRAPES)
    : [];

  const confidence = typeof data.confidence === 'number' && Number.isFinite(data.confidence)
    ? Math.min(1, Math.max(0, data.confidence))
    : null;

  return {
    name,
    producer,
    country: cleanField(data.country),
    region: cleanField(data.region),
    appellation: cleanField(data.appellation),
    type: WINE_TYPES.includes(data.type) ? data.type : null,
    grapes,
    confidence,
  };
}

/**
 * 429 for the Anthropic-backed endpoints when the shared per-user daily AI
 * budget (or the site-wide daily cap) is exhausted. These endpoints have no
 * non-AI fallback, unlike the import pipeline (which degrades to fuzzy
 * matching instead). Retry-After points at the next UTC midnight, when the
 * daily window resets.
 */
function sendAiBudgetExhausted(res, debit) {
  // Demo accounts get no AI at all — a distinct, non-retryable 403 so the client
  // shows "sign up to use AI" rather than a "try again at midnight" budget message.
  if (debit.reason === 'demo_disabled') {
    return res.status(403).json({
      error: 'AI features are not available in the demo. Create a free account to use them.',
      code: 'demo_ai_disabled',
    });
  }
  res.set('Retry-After', String(debit.retryAfterSeconds));
  return res.status(429).json({
    error: 'Daily AI budget reached. AI features reset at midnight UTC.',
    code: 'ai_budget_exhausted',
    scope: debit.reason, // 'user_budget' | 'global_cap'
    retryAfterSeconds: debit.retryAfterSeconds,
  });
}

/**
 * "Is this scanned identity already in the registry?" — ONE implementation,
 * shared by the front scan and the back-label rescue scan.
 *
 * Extracted rather than duplicated the moment a second scan endpoint needed it:
 * the three-step ladder below (exact normalizedKey → Meilisearch candidates →
 * $text fallback → shared composite scorer at ≥0.75) is the dedup contract, and
 * two copies of it drifting apart would mean the same bottle matched on the
 * front scan and minted a duplicate on the back scan.
 *
 * Tolerates a PARTIAL identity by design: a half-read label reaching here with
 * a name and no producer still gets a lookup — findBestMatch scores the fields
 * it is given (producer is 45% of the composite, so a producerless identity
 * simply cannot clear 0.75 on its own, which is the correct outcome: no
 * silent attachment to somebody else's wine).
 *
 * @returns {Promise<{wine, confidence}|null>}
 */
async function matchScannedIdentity({ name, producer, appellation }) {
  // Both fields are needed before the registry is consulted at all: with one of
  // them missing the exact key cannot be generated and the fuzzy query degrades
  // to a single token, which matches everything and therefore nothing useful.
  if (!name || !producer) return null;

  // 1. Exact normalizedKey match
  const normalizedKey = generateWineKey(name, producer, appellation);
  const wine = await WineDefinition.findOne({ normalizedKey })
    .populate(['country', 'region', 'grapes']);
  if (wine) return { wine, confidence: 1.0 };

  // 2. Fuzzy search
  const searchQuery = `${name} ${producer}`.trim();
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

  // Use the shared scorer so scan-label, find-or-create and import all
  // dedup with one implementation. redistribute:false preserves this
  // path's historical "neither side has an appellation → full weight"
  // behaviour (matching find-or-create).
  const { bestMatch, bestScore } = findBestMatch(
    { name, producer, appellation },
    candidates,
    { redistribute: false }
  );

  if (bestScore >= 0.75 && bestMatch) {
    return { wine: bestMatch, confidence: Math.round(bestScore * 100) / 100 };
  }
  return null;
}

const USER_SEARCH_LIMIT = 10;

// MongoDB fallback search (used when Meilisearch is unavailable)
async function mongoSearch(filter, sort, limit, offset, search) {
  // Quarantined non-wine rows never surface in registry search — the Meili
  // branch excludes them at index time; this is the fallback's mirror. Same for
  // pendingIdentity rows: they are not in the index either, so without this the
  // Mongo fallback would be the one surface that leaks them (and this list is
  // also what the wine-list / wishlist / add-bottle pickers read).
  filter.nonWine = { $ne: true };
  filter.pendingIdentity = { $ne: true };
  let sortOptions = {};
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
    // Relevance first, field sort as tiebreak — MongoDB sorts by key order,
    // so score must precede the field sort or ranking is effectively ignored.
    sortOptions = { score: { $meta: 'textScore' }, ...sortOptions };
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

    // Build MongoDB filter (used for non-search queries and as fallback).
    // Invalid country/region ids are a 400 — the old `? id : undefined`
    // assignment made Mongoose drop the condition and silently return the
    // UNFILTERED list for e.g. ?country=France.
    const filter = {};
    if (country) {
      if (!mongoose.isValidObjectId(String(country))) return res.status(400).json({ error: 'Invalid country ID' });
      filter.country = String(country);
    }
    if (region) {
      if (!mongoose.isValidObjectId(String(region))) return res.status(400).json({ error: 'Invalid region ID' });
      filter.region = String(region);
    }
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
          wines: wines.map(decorateGrapes)
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
      wines: wines.map(decorateGrapes)
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
//        (mediaType is accepted for compatibility but ignored — the actual type
//         is detected from the sanitized bytes, since the declared one can lie)
// Returns: {
//   extracted: { name, producer, vintage, country, region, appellation, type,
//                grapes[], partial?: true, producer_suspect?: "<rule id>" },
//   match: { wine: WineDefinition, confidence: number } | null,
//   labelImage: "data:image/png;base64,..." (background-removed label, or original as fallback),
//   scanImageId: "<BottleImage id>" | null
// }
//
// `extracted.partial` marks a HALF-READ label — one of name/producer came back
// empty, OR the producer that came back is not a producer at all (see
// flagSuspectProducer; `producer_suspect` then names the cross-field rule that
// caught it). It is a 200, not an error: the fields that WERE read prefill the
// form, the frame is kept, and the client may offer the optional back-label
// rescue (POST /scan-label-back). A 422 (nothing readable at all) now also carries
// `scanImageId`, for the same reason — the user is about to type the wine by
// hand, and that manual entry mints the pending row the photo is evidence for.
//
// scanImageId: the ORIGINAL frame is now persisted (private, kind:'label-scan')
// instead of being discarded with the request. The client threads it back
// inside `newWine` on the bottle/wishlist commit, where it is stamped onto the
// minted wine — that photo is what lets a curator FIX a wine the extraction
// could not identify, which is the whole point of the pending-identity queue.
// A scan that never gets committed is swept after 30 days
// (services/scanImageRetentionJob.js). GDPR: no new consent category — this is
// a bottle photo, in the same collection, under the same EXIF-strip, exported
// and erased with all the others.
// asyncHandler (mirrors chat.js): if tryDebitAi rejects on a Mongo error — it
// runs BEFORE the try below — Express 4 would otherwise leave the request
// hanging on an unhandled rejection instead of responding 500 (audit HIGH).
router.post('/scan-label', requireAuth, aiBurstLimiter, asyncHandler(async (req, res) => {
  const { image } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'Image is required' });
  }

  // 0. Fail-closed pixel/format guard + EXIF strip BEFORE anything touches the
  // bytes. Without it a small compressed payload can decode to a 100M+ pixel
  // "decompression bomb" on the single-worker rembg service (DoS). Mirrors the
  // hardened /api/images/remove-bg-preview path. The sanitizer preserves the
  // DECODED format, so the media type is re-detected from the sanitized bytes
  // rather than trusting the client-declared mediaType.
  // (Body limit for this path is 300kb — app.js — sized to the camera hook's
  // 800px JPEG captures, the only client that calls this.)
  let safeBuffer;
  try {
    safeBuffer = await sanitizeImageBuffer(Buffer.from(image, 'base64'));
  } catch {
    return res.status(400).json({ error: 'Image is too large or not a valid JPEG, PNG, or WebP' });
  }
  const safeMediaType = `image/${detectImageFormat(safeBuffer) || 'jpeg'}`;

  // Debit the shared daily AI budget BEFORE any expensive work (rembg + the
  // Claude vision call); refunded below if the scan fails (mirrors chat's
  // debit-before / refund-on-error pattern).
  const debit = await tryDebitAi(req.user.id, { isDemo: req.user.isDemo });
  if (!debit.ok) return sendAiBudgetExhausted(res, debit);

  // Phase 1: the billable work (rembg + the Claude vision call). Refund the
  // debit ONLY on a failure that produced no billable completion (no API key,
  // unsupported image, transport error). A completed-but-unhelpful call
  // (422 "Could not read label") STAYS debited — mirrors identify-text/ai-info
  // and closes the budget + kill-switch bypass via unreadable labels (audit HIGH).
  let extracted;
  let labelImage;
  try {
    // 1. Attempt background removal via rembg (non-fatal — falls back to the
    //    sanitized original)
    let scanImage = safeBuffer.toString('base64');
    let scanMediaType = safeMediaType;
    labelImage = `data:${scanMediaType};base64,${scanImage}`;

    try {
      const fd = new FormData();
      fd.append('image', new Blob([safeBuffer], { type: safeMediaType }), 'label.jpg');
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

    // 2. Extract wine info via Claude.
    //
    // allowPartial: a label that yielded a producer and no name (or the
    // reverse) used to 422 here, and the photo went to the garbage collector
    // with the request. The user then typed the wine by hand, the commit minted
    // a pendingIdentity row, and the curator got a broken string and NO
    // evidence — the exact case the queue exists to serve. A half-read now
    // comes back with `partial: true` and the frame is kept either way (below).
    extracted = await scanLabelFull(scanImage, scanMediaType, { allowPartial: true });
  } catch (err) {
    // Only a pre-completion / transport failure refunds; a completed 422 stays debited.
    if (isRefundableScanError(err)) await debit.refund();
    console.error('Label scan error:', err.message);

    // A 422 means the AI call COMPLETED and read nothing usable — and that is
    // precisely when the stored frame matters most: the user is about to type
    // the wine by hand, and their manual entry will mint a pending row. Keep
    // the frame and hand back its id so it can ride that commit. A user who
    // walks away instead leaves an unattached scan, garbage-collected by the
    // 30-day sweep (services/scanImageRetentionJob). Best-effort — a storage
    // failure must not change the error the client sees.
    if (err.status === 422) {
      const orphan = await persistLabelScan({ buffer: safeBuffer, userId: req.user.id, side: 'front' });
      return res.status(422).json({
        error: err.message || 'Could not read label',
        scanImageId: orphan ? String(orphan._id) : null,
      });
    }
    return res.status(err.status || 500).json({ error: err.message || 'Label scan failed' });
  }

  // Phase 2: registry match + response. The billable call has completed and
  // been paid for — a failure here (e.g. a DB error) returns 500 WITHOUT a
  // refund, since the AI work really happened.
  try {
    // Run the match on whatever the extraction produced: the shared helper is
    // the one place that decides what a half-read identity can and cannot
    // match (see matchScannedIdentity).
    const match = await matchScannedIdentity(extracted);

    // A producer the cross-field rules say is not a producer makes this a
    // HALF-READ label, whatever the model filled the box with — the same
    // `partial` treatment a genuinely empty producer already gets. Runs AFTER
    // the match: the soft place-plus-filler flag applies only when the
    // registry matched nothing (see the helper's comment).
    await flagSuspectProducer(extracted, { match });

    // Keep the sanitized ORIGINAL (not the background-removed render — a
    // curator wants the untouched frame). Best-effort: a storage failure
    // returns null and the scan still succeeds. Demo accounts never reach here
    // (tryDebitAi refuses them above), so no throwaway account writes files.
    const scanImage = await persistLabelScan({ buffer: safeBuffer, userId: req.user.id, side: 'front' });

    res.json({ extracted, match, labelImage, scanImageId: scanImage ? String(scanImage._id) : null });
  } catch (err) {
    console.error('Label scan match error:', err.message);
    res.status(500).json({ error: 'Label scan failed' });
  }
}));

// POST /api/wines/scan-label-back
// The BACK-LABEL RESCUE scan. Optional, and offered only after a front scan
// came back incomplete (`extracted.partial`) or unreadable (422): the user
// photographs the back label, and the fields the front could not supply are
// filled from it.
//
// Body: {
//   image: base64 (the BACK photo — required),
//   frontImage?: base64 (the front frame, still in the client's hands),
//   frontExtracted?: { name, producer, vintage, country, region, appellation,
//                      type, grapes[] },   // what the front scan produced
//   frontScanImageId?: "<BottleImage id>"  // echoed back so the client can
//                                          // thread BOTH ids to the commit
// }
// Returns: { merged, conflicts, filled, match, backScanImageId, frontScanImageId }
//
// The MERGE is server-side and deterministic (services/labelScan.mergeBackScan):
// the front value wins every contested scalar, the back fills only blanks, and
// a real disagreement is recorded rather than resolved. The model is never
// asked to decide which label is right.
//
// No rembg: background removal exists to render a pretty label card for the
// front photo. Nobody displays a back label, and the stored frame must be the
// untouched original anyway.
//
// GDPR: the back photo is the SAME data category as the front one — a private
// photo of the user's own bottle, kind:'label-scan', EXIF-stripped by the same
// sanitizer, exported with the others, erased with the account, and expired by
// both retention sweeps. No new consent category.
router.post('/scan-label-back', requireAuth, aiBurstLimiter, asyncHandler(async (req, res) => {
  const { image, frontImage, frontExtracted, frontScanImageId } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'Image is required' });
  }

  // Bound the front context BEFORE any AI call: these values are substituted
  // into a prompt (sanitised again in scanLabelBack, belt and braces), and an
  // oversized payload is a cost attack, not a user error to be tolerated.
  // Same caps as the registry-write path, imported not re-declared.
  //
  // ALLOWLIST, not a loop over whatever arrived (release-audit HIGH-1): the
  // client sends back the `extracted` object /scan-label handed it, VERBATIM —
  // including `partial: true`, the very flag that makes the rescue worth
  // offering. A validator that 400'd on any non-string key therefore rejected
  // the feature's primary case (and a model returning `"vintage": 2019` as a
  // number tripped it too). Unknown and non-string members are DROPPED here,
  // so only the eight identity fields ever reach the prompt or the merge.
  let front = {};
  if (frontExtracted !== undefined) {
    if (!frontExtracted || typeof frontExtracted !== 'object' || Array.isArray(frontExtracted)) {
      return res.status(400).json({ error: 'frontExtracted must be an object' });
    }
    for (const key of ['name', 'producer', 'vintage', 'country', 'region', 'appellation', 'type']) {
      const value = frontExtracted[key];
      if (typeof value !== 'string') continue;
      if (value.length > MAX_WINE_FIELD) {
        return res.status(400).json({ error: `frontExtracted.${key} must be a string of ${MAX_WINE_FIELD} characters or fewer` });
      }
      front[key] = value;
    }
    const { grapes } = frontExtracted;
    if (Array.isArray(grapes)) {
      if (grapes.length > MAX_GRAPES) {
        return res.status(400).json({ error: `frontExtracted.grapes must be an array of at most ${MAX_GRAPES} entries` });
      }
      if (grapes.some(g => typeof g !== 'string' || g.length > MAX_WINE_FIELD)) {
        return res.status(400).json({ error: `each grape must be a string of ${MAX_WINE_FIELD} characters or fewer` });
      }
      front.grapes = grapes;
    }
  }

  // Same fail-closed pixel/format guard + EXIF strip as the front route, on
  // BOTH frames. The front one is re-sanitised rather than trusted: the client
  // is sending bytes back to us, and "we sanitised this a minute ago" is not a
  // property of the bytes in this request.
  let safeBack;
  try {
    safeBack = await sanitizeImageBuffer(Buffer.from(image, 'base64'));
  } catch {
    return res.status(400).json({ error: 'Image is too large or not a valid JPEG, PNG, or WebP' });
  }
  const safeBackType = `image/${detectImageFormat(safeBack) || 'jpeg'}`;

  let safeFront = null;
  if (frontImage) {
    try {
      safeFront = await sanitizeImageBuffer(Buffer.from(frontImage, 'base64'));
    } catch {
      // Non-fatal: the back label alone is still a useful read. Dropping the
      // front frame degrades the scan; refusing the request would waste the
      // photo the user just took.
      safeFront = null;
    }
  }
  const safeFrontType = safeFront ? `image/${detectImageFormat(safeFront) || 'jpeg'}` : null;

  // Identical debit-before / refund-on-pre-completion-failure semantics to the
  // front route: a completed-but-unhelpful call (422 "could not read back
  // label") STAYS debited, which is what closes the budget bypass.
  const debit = await tryDebitAi(req.user.id, { isDemo: req.user.isDemo });
  if (!debit.ok) return sendAiBudgetExhausted(res, debit);

  let back;
  try {
    back = await scanLabelBack({
      backImage: safeBack.toString('base64'),
      backMediaType: safeBackType,
      frontImage: safeFront ? safeFront.toString('base64') : undefined,
      frontMediaType: safeFrontType || undefined,
      frontExtracted: front,
    });
  } catch (err) {
    if (isRefundableScanError(err)) await debit.refund();
    console.error('Back-label scan error:', err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Back-label scan failed' });
  }

  // Phase 2: merge + match + persist. The billable call is paid for, so a
  // failure here is a 500 WITHOUT a refund.
  try {
    // The ALLOWLISTED front object, so junk keys a hostile client stuffed into
    // frontExtracted can never ride mergeBackScan's spread back out to the
    // client (audit INFO-1).
    // The client echoes the front response's producer_suspect flag; it never
    // enters the allowlisted `front` object (schema fields only), but it tells
    // the merge that a usable back producer should WIN that field rather than
    // lose to the flagged string (release-audit M-1 — front-wins made the
    // rescue inert for the very case that triggers it).
    const suspectProducer = typeof frontExtracted?.producer_suspect === 'string'
      && frontExtracted.producer_suspect.length <= 64;
    const { merged, conflicts, filled } = mergeBackScan(front, back, { suspectProducer });

    // Re-run the registry lookup on the MERGED identity — the whole point of
    // the rescue is that the wine may now be identifiable when it was not.
    const match = await matchScannedIdentity(merged);

    // The rescue can also FILL the producer box with a string that is not a
    // producer (the back label's "Produit de France" line is the classic), and
    // the merged identity is what the commit will carry — so it gets the same
    // check the front scan got. Re-evaluated rather than carried over from the
    // front response: the merge may have replaced a blank producer with a back
    // value, or left a suspect front value in place, and only the merged row
    // says which. After the match, for the same soft-flag rule as the front.
    await flagSuspectProducer(merged, { match });

    // side:'back' so a curator shown two frames is told which is which.
    const backScan = await persistLabelScan({ buffer: safeBack, userId: req.user.id, side: 'back' });

    res.json({
      merged,
      conflicts,
      filled,
      match,
      backScanImageId: backScan ? String(backScan._id) : null,
      // Echoed, not re-derived: the client threads both ids into the commit,
      // and this keeps the two halves of that payload coming from one response.
      frontScanImageId: typeof frontScanImageId === 'string' && isValidId(frontScanImageId)
        ? frontScanImageId
        : null,
    });
  } catch (err) {
    console.error('Back-label merge error:', err.message);
    res.status(500).json({ error: 'Back-label scan failed' });
  }
}));

// POST /api/wines/find-or-create — resolve a confirmed wine against the
// registry. RESOLVE-ONLY: this route creates nothing (path kept for client
// compatibility; it is the add flows' step-1 lookup/soft-zone endpoint).
//
// It used to mint the WineDefinition (plus Country/Region/Grape taxonomy) the
// moment the user confirmed the wine in STEP 1 of AddBottle/AddToWishlist —
// before any bottle existed. A user who abandoned the flow left an orphan
// registry row forever. Measured on prod 2026-08-10: 31 zero-bottle
// createdVia:'ui' rows; the same day a user minted "Domaine de Riquewihr —
// Kaefferkopf" (village-as-producer, likely fictitious) and two minutes later
// attached their bottle to a DIFFERENT existing wine. Creation now happens at
// the commit itself — POST /api/bottles / POST /api/wishlist with `newWine`
// (services/wineCommit) — exactly the shape of the two prior fixes:
// identify-text went read-only in v1.97 (52% orphan rate for 'ai' rows) and
// import /validate went registry-read-only in v1.100.0 (#899).
//
// Body:  { name, producer, country, region?, appellation?, type?, grapes? }
//        (confirmCreate / source / labelImage are accepted and IGNORED — a
//         stale client may still send them; nothing here creates, so there is
//         nothing to confirm or stamp.)
// Returns 200 with one of:
//   { wine, created: false }               — confident match (exact key,
//                                            canonical/sibling, or score ≥0.95)
//   { candidates: [{ wine, score }, ...] } — soft zone: ask "did you mean…?"
//   { wine: null, created: false, noMatch: true }
//                                          — not in the registry. The client
//                                            carries the fields to the bottle/
//                                            wishlist commit, which mints.
// Never 201: `created` is always false here. Consumers that assumed a saved
// document on the noMatch shape fail loudly (wine is null), not silently.
//
// requireNonDemo kept deliberately: this endpoint only serves the add flows,
// which the demo does not have (POST /api/bottles is requireNonDemo, AddBottle
// shows a sign-up nudge) — loosening it would be an unrelated semantic change.
// asyncHandler: `?.trim()` only short-circuits on null/undefined — a numeric
// `name` threw a rejection Express 4 never catches, so the request hung open
// forever. The shared validator 400s non-strings before the service runs.
router.post('/find-or-create', requireAuth, requireNonDemo, asyncHandler(async (req, res) => {
  const { name, producer, country, region, appellation, type, grapes } = req.body;

  // Same caps as the commit path (shared helper): the free-text fields feed
  // the O(m·n) fuzzy-match scorer, and the body limit here is 5mb — a
  // multi-MB name/producer would be an authenticated DoS.
  //
  // allowPending relaxes ONLY the producer requirement, because the add flows
  // now let a user leave the producer blank when the label is unreadable. This
  // route still creates nothing (matchOnly); a producerless probe simply can't
  // score high enough to auto-match or soft-zone — producer carries 45% of the
  // composite — so it returns noMatch and the fields ride to the commit, which
  // mints the pending row.
  const invalid = validateNewWineFields(req.body, { allowPending: true });
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    // matchOnly and NOTHING else — same probe identify-text uses. confirmCreate
    // must never ride along: it would gate off the soft-zone return that sits
    // above the matchOnly gate, collapsing every 0.85–0.95 near-match into
    // noMatch, which is exactly the duplication this endpoint exists to stop.
    const probe = await findOrCreateWine(
      // '' not undefined: findOrCreateWine's .trim() runs before any option is
      // consulted, and a probe must never be the thing that 500s.
      { name, producer: typeof producer === 'string' ? producer : '', country, region, appellation, type, grapes: grapes || [] },
      req.user.id,
      { matchOnly: true }
    );

    if (probe.wine) return res.json({ wine: probe.wine, created: false });
    if (probe.candidates?.length) return res.status(200).json({ candidates: probe.candidates });
    return res.json({ wine: null, created: false, noMatch: true });
  } catch (err) {
    console.error('Resolve wine error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to resolve wine' });
  }
}));

// POST /api/wines/identify-text — identify a wine from a free-text query using
// AI and report what the registry already holds. READ-ONLY: this route creates
// nothing.
//
// It used to call findOrCreateWine unconditionally, minting a WineDefinition
// (plus Country/Region/Grape taxonomy) for every AI guess — before the user
// confirmed and before any bottle existed. Measured on prod 2026-08-03: 85 of
// 162 createdVia:'ai' rows had zero bottles (52%) against 3% for 'ui', and the
// same producer arrived spelled three ways from one user retyping a query.
// Creation now happens only when the user COMMITS — POST /api/bottles /
// /api/wishlist with `newWine` (services/wineCommit); an accepted suggestion
// rides along as fields until then. (/find-or-create was the interim mint
// point; it went resolve-only when the 'ui' source grew the same orphan
// pattern — 31 zero-bottle rows by 2026-08-10.)
//
// Response — 200, one shape with four states:
//   { identified: {name, producer, country, region, appellation, type,
//                  grapes: string[], confidence} | null,   // UNSAVED strings
//     match:      { wine: <populated WineDefinition> } | null,
//     candidates: [{ wine, score }],
//     reason:     string | null }
//
// Invariants:
//   1. identified === null  ⟺ the model produced nothing usable; reason is set.
//   2. match !== null       ⟹ candidates is [] and reason is null.
//   3. candidates.length>0  ⟹ match is null.
//   4. identified && !match && !candidates.length ⟹ identified but NOT in the
//      registry — the state this route exists to report.
// There is deliberately no top-level `wine`/`created`: the rename makes any
// consumer that assumed a saved document fail loudly rather than silently
// dereference undefined.
//
// `match` carries no confidence: findOrCreateWine resolves via exact key,
// canonicalKey, sibling prefix or score ≥ 0.95 without reporting which, so any
// number here would be fabricated. It stays an object so one can be added later.
//
// Stays a POST though it is semantically a read — app.js's writeLimiter skips
// GET/HEAD/OPTIONS, and this path must keep its rate limit.
//
// asyncHandler: tryDebitAi runs before the try; a Mongo error there must 500, not hang (audit HIGH).
router.post('/identify-text', requireAuth, aiBurstLimiter, asyncHandler(async (req, res) => {
  const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (query.length > MAX_AI_QUERY_LEN) return res.status(400).json({ error: `query must be at most ${MAX_AI_QUERY_LEN} characters` });

  // Demo accounts are stopped here, inside tryDebitAi — no requireNonDemo
  // needed, and adding one would swap this coded 403 for an uncoded one.
  const debit = await tryDebitAi(req.user.id, { isDemo: req.user.isDemo });
  if (!debit.ok) return sendAiBudgetExhausted(res, debit);

  // Phase 1: the billable call. Only a pre-completion / transport failure refunds.
  let result;
  try {
    result = await identifyWineFromQuery(query);
  } catch (err) {
    await debit.refund();
    console.error('Identify text error:', err);
    return res.status(500).json({ error: err.message || 'Failed to identify wine' });
  }

  if (!result.data) {
    if (isRefundableFailure(result.debugReason)) await debit.refund();
    return res.json({ identified: null, match: null, candidates: [], reason: result.debugReason });
  }

  const identified = normalizeIdentifiedWine(result.data);
  if (!identified) {
    // A completed, billed call that returned an unusable identity — no refund.
    return res.json({ identified: null, match: null, candidates: [], reason: 'invalid_identity_fields' });
  }

  // Phase 2: registry probe. The billable call has completed and been paid for —
  // a failure here (e.g. a DB error) returns 500 WITHOUT a refund, since the AI
  // work really happened. The old blanket catch-and-refund reversed both the
  // per-user debit and the site-wide kill-switch on any throw, and the soft-zone
  // shape below reached it on every near-match.
  try {
    // matchOnly and NOTHING else. confirmCreate would gate off the soft-zone
    // return that sits above the matchOnly gate, collapsing every 0.85–0.95
    // near-match into noMatch — which is exactly the duplication this fixes.
    const probe = await findOrCreateWine(identified, req.user.id, { matchOnly: true });

    // decorateGrapes on every wine that leaves this route: the AI-identify
    // card sits NEXT TO the search list, which already shows the regional
    // grape label ("Tinta Roriz" on a Douro row) — the two must agree.
    if (probe.wine) {
      return res.json({ identified, match: { wine: decorateGrapes(probe.wine) }, candidates: [], reason: null });
    }
    if (probe.candidates?.length) {
      return res.json({
        identified,
        match: null,
        candidates: probe.candidates.map((c) => ({ ...c, wine: decorateGrapes(c.wine) })),
        reason: null,
      });
    }
    return res.json({ identified, match: null, candidates: [], reason: null });
  } catch (err) {
    console.error('Identify text probe error:', err);
    return res.status(500).json({ error: 'Failed to identify wine' });
  }
}));

// POST /api/wines/ai-info — query AI for wine info without creating anything in DB.
// Returns raw AI-identified data (country/region/grapes as name strings, not IDs).
// Used by the AdminRequests page to pre-fill the Create New Wine form.
// asyncHandler: tryDebitAi runs before the try; a Mongo error there must 500, not hang (audit HIGH).
router.post('/ai-info', requireAuth, aiBurstLimiter, asyncHandler(async (req, res) => {
  const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (query.length > MAX_AI_QUERY_LEN) return res.status(400).json({ error: `query must be at most ${MAX_AI_QUERY_LEN} characters` });

  const debit = await tryDebitAi(req.user.id, { isDemo: req.user.isDemo });
  if (!debit.ok) return sendAiBudgetExhausted(res, debit);

  try {
    const result = await identifyWineFromQuery(query);
    if (!result.data) {
      // Transport-level failures never produced a billable completion
      if (isRefundableFailure(result.debugReason)) await debit.refund();
      return res.json({ wine: null, reason: result.debugReason });
    }
    return res.json({ wine: result.data });
  } catch (err) {
    await debit.refund();
    console.error('AI info error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get AI wine info' });
  }
}));

// GET /api/wines/:idOrSlug/public — Public wine detail (no auth required)
// Accepts both ObjectId and slug. Used for shared links and social previews.
const PUBLIC_PROJECTION = 'name producer slug country region appellation grapes type image communityRating classification aiProfile';

// Anti-enumeration limit for the ONE wine endpoint that needs no account.
//
// Public wine pages are deliberate — they are how a wine is shared and
// indexed, and the slugs are not going anywhere. But "readable" and
// "downloadable in bulk" are different things, and until now they were the
// same thing: this route sat under the general /api/ limiter at 2500 per 15
// minutes, so a single address could walk the entire registry in about the
// time it takes to make lunch.
//
// The cap is sized from measured traffic, not caution: across 24 hours this
// endpoint served FIVE requests, from one address, all real browsers, and no
// search crawler touched it at all. 120 per 15 minutes is therefore about
// twenty times the entire site's daily use of it, per address — invisible to
// anyone reading wine pages, including a logged-in user (the frontend calls
// this route for everyone, so the cap must clear real browsing and does).
//
// A 429 here is worth SEEING rather than silently absorbing: ordinary use
// cannot reach it, so a breach is either a scraper or a real usage pattern
// nobody predicted. Both are things to know about, hence the audit row.
const publicWineLimiter = rateLimit({
  // Static window, dynamic max — the same shape as apiLimiter and
  // aiBurstLimiter. express-rate-limit resolves max() per request but wants a
  // real number for the window at construction.
  windowMs: rateLimitsConfig.get().publicWineRead.windowMs,
  max: () => rateLimitsConfig.get().publicWineRead.max,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, {
      limiter: 'publicWineRead',
      limit: rateLimitsConfig.get().publicWineRead.max,
    });
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});
router.get('/:idOrSlug/public', publicWineLimiter, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    // Unauthenticated share/preview surface — quarantined non-wines are hidden
    // here for the same reason as on the OG page (code audit 2026-07-27, M5).
    // The authenticated /:id route below deliberately still resolves them, so
    // an owner's own bottle page keeps working: hiding, not breaking.
    // pendingIdentity joins the exclusion: this route is unauthenticated, so
    // there is nobody here who could be the creator — a half-identified wine
    // must simply not have a public page (nor an OG card, nor a sitemap entry).
    const hidden = { nonWine: { $ne: true }, pendingIdentity: { $ne: true } };
    // slugFilter resolves SUPERSEDED slugs too, so a link that predates a name
    // correction still opens the wine (models/WineDefinition.previousSlugs).
    const filter = isValidId(idOrSlug)
      ? { _id: idOrSlug, ...hidden }
      : { ...WineDefinition.slugFilter(idOrSlug), ...hidden };

    const wine = await WineDefinition.findOne(filter)
      .populate(['country', 'region', 'grapes'])
      .select(PUBLIC_PROJECTION);

    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    res.json({ wine: decorateGrapes(wine) });
  } catch (error) {
    console.error('Get public wine error:', error);
    res.status(500).json({ error: 'Failed to get wine' });
  }
});

// GET /api/wines/:idOrSlug/community-prices?currency=SEK
// Per-vintage community release-price curve (what users actually paid) for one
// currency, newest vintage first. Public, unattributed product data — never
// converted across currencies. Returns { currency, currentRelease, curve }.
router.get('/:idOrSlug/community-prices', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const currency = String(req.query.currency || 'USD').toUpperCase().slice(0, 10);
    const filter = isValidId(idOrSlug)
      ? { _id: idOrSlug }
      : WineDefinition.slugFilter(idOrSlug);

    const wine = await WineDefinition.findOne(filter).select('_id').lean();
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    const curve = await getReleaseCurve(wine._id, currency);
    const currentRelease = curve.length
      ? {
          vintage: curve[0].vintage,
          medianPrice: curve[0].medianPrice,
          currency: curve[0].currency,
          sampleSize: curve[0].sampleSize,
          confidence: curve[0].confidence,
        }
      : null;

    res.json({ currency, currentRelease, curve });
  } catch (error) {
    console.error('Get community prices error:', error);
    res.status(500).json({ error: 'Failed to get community prices' });
  }
});

// Authenticated wine detail. A pendingIdentity row is visible ONLY to its
// creator (whose bottle page has to render — hiding, not breaking, same
// principle as the nonWine quarantine one route up) and to curation
// (somm/admin, who work the pending queue). Everyone else gets the same 404 a
// non-existent id gets, so the row's existence never leaks.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    // The label-scan evidence fields belong to the pending queue (which has
    // its own gated surfaces), not to a general wine read: conflicts survive
    // promotion for the 7-day correction window, and any logged-in user could
    // read that label text here (release-audit LOW-3 — same rationale as the
    // wishlist $unset). Image BYTES were always gated per-image; this hides
    // the pointers and the text.
    const wine = await WineDefinition.findById(req.params.id)
      .select('-scanImage -scanImageBack -scanFieldConflicts')
      .populate(['country', 'region', 'grapes']);

    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }
    if (wine.pendingIdentity === true) {
      const isCurator = req.user.roles.includes('admin') || req.user.roles.includes('somm');
      if (!isCurator && String(wine.createdBy) !== String(req.user.id)) {
        return res.status(404).json({ error: 'Wine not found' });
      }
    }

    res.json({ wine: decorateGrapes(wine) });
  } catch (error) {
    console.error('Get wine error:', error);
    res.status(500).json({ error: 'Failed to get wine' });
  }
});

// GET /api/wines/:idOrSlug/discussions — Public-readable list of discussions
// linked to a wine. Used by the WineDetail page's "Discussions about this wine"
// panel and by future wine-page widgets.
router.get('/:idOrSlug/discussions', optionalAuth, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const filter = isValidId(idOrSlug)
      ? { _id: idOrSlug }
      : WineDefinition.slugFilter(idOrSlug);

    const wine = await WineDefinition.findOne(filter).select('_id');
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    const { page, limit, offset: skip } = parsePagination(req.query, { limit: 10, maxLimit: 30 });

    const [discussions, total] = await Promise.all([
      Discussion.find({ wineDefinition: wine._id })
        .sort({ isPinned: -1, lastActivityAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName roles contribution.tier contribution.specialty')
        .select('title slug body category replyCount lastActivityAt createdAt isPinned isLocked author wineDefinition'),
      Discussion.countDocuments({ wineDefinition: wine._id })
    ]);

    res.json({ discussions, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('List wine discussions error:', error);
    res.status(500).json({ error: 'Failed to list discussions' });
  }
});

module.exports = router;
