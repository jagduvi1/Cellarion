const express = require('express');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Discussion = require('../models/Discussion');
const searchService = require('../services/search');
const { requireAuth, requireNonDemo, optionalAuth } = require('../middleware/auth');
const { scanLabelFull, identifyWineFromQuery } = require('../services/labelScan');
const { sanitizeImageBuffer, detectImageFormat } = require('../services/imageSanitizer');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { generateWineKey } = require('../utils/normalize');
const { findBestMatch } = require('../services/wineMatching');
const { parsePagination } = require('../utils/pagination');
const { isValidId } = require('../utils/validation');
// Read-surface decoration: each populated grape gains `displayName` — the
// regionally correct label for THIS wine (Tinta Roriz on a Douro Port) —
// while `name` stays canonical. Storage/filters/stats are untouched.
const { decorateGrapes } = require('../utils/grapeDisplay');
const { submitUrls } = require('../services/indexNow');
const { getReleaseCurve } = require('../services/communityPrice');
const aiBurstLimiter = require('../middleware/aiBurstLimiter');
const asyncHandler = require('../utils/asyncHandler');
const { tryDebitAi, isRefundableFailure, isRefundableScanError } = require('../services/aiBudget');
const { logAudit } = require('../services/audit');

const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';

const router = express.Router();

// Cap the free-text AI query length before it becomes Claude prompt input, so a
// caller can't maximize per-call input-token cost with a ~10KB body. Mirrors the
// chat message cap (chat.js).
const MAX_AI_QUERY_LEN = 300;

// Field caps for anything that reaches the registry-write path. Mirrors the
// value findOrCreateWine enforces at its own create chokepoint.
const MAX_WINE_FIELD = 200;
const MAX_GRAPES = 20;
const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

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

const USER_SEARCH_LIMIT = 10;

// MongoDB fallback search (used when Meilisearch is unavailable)
async function mongoSearch(filter, sort, limit, offset, search) {
  // Quarantined non-wine rows never surface in registry search — the Meili
  // branch excludes them at index time; this is the fallback's mirror.
  filter.nonWine = { $ne: true };
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
//   extracted: { name, producer, vintage, country, region, appellation, type, grapes[] },
//   match: { wine: WineDefinition, confidence: number } | null,
//   labelImage: "data:image/png;base64,..." (background-removed label, or original as fallback)
// }
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

    // 2. Extract wine info via Claude
    extracted = await scanLabelFull(scanImage, scanMediaType);
  } catch (err) {
    // Only a pre-completion / transport failure refunds; a completed 422 stays debited.
    if (isRefundableScanError(err)) await debit.refund();
    console.error('Label scan error:', err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Label scan failed' });
  }

  // Phase 2: registry match + response. The billable call has completed and
  // been paid for — a failure here (e.g. a DB error) returns 500 WITHOUT a
  // refund, since the AI work really happened.
  try {
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

        // Use the shared scorer so scan-label, find-or-create and import all
        // dedup with one implementation. redistribute:false preserves this
        // path's historical "neither side has an appellation → full weight"
        // behaviour (matching find-or-create).
        const { bestMatch, bestScore } = findBestMatch(
          { name: extracted.name, producer: extracted.producer, appellation: extracted.appellation },
          candidates,
          { redistribute: false }
        );

        if (bestScore >= 0.75 && bestMatch) {
          match = { wine: bestMatch, confidence: Math.round(bestScore * 100) / 100 };
        }
      }
    }

    res.json({ extracted, match, labelImage });
  } catch (err) {
    console.error('Label scan match error:', err.message);
    res.status(500).json({ error: 'Label scan failed' });
  }
}));

// POST /api/wines/find-or-create
// Called after the user confirms (and optionally edits) the AI-extracted wine data.
// Finds an existing matching wine or creates a new one, including any needed
// taxonomy records (country, region, grapes).
//
// Body:  { name, producer, country, region?, appellation?, type?, grapes?: string[],
//           labelImage?: "data:image/png;base64,...", confirmCreate?: boolean }
// Returns one of:
//   { wine: WineDefinition, created: false }       — exact or auto-fuzzy match
//   { candidates: [{ wine, score }, ...] }         — soft-zone: similar wines exist,
//                                                     UI should ask "did you mean…?"
//   { wine: WineDefinition, created: true }        — new wine created
//
// Pass `confirmCreate: true` after the user has reviewed the soft-zone
// candidates and explicitly chosen to create a new wine anyway.
//
// `source: 'ai'` marks "the user accepted an AI suggestion" and stamps
// createdVia:'ai'. Note the semantic shift: before identify-text became
// read-only, createdVia:'ai' meant "auto-minted with nobody's confirmation"
// (the ~162 pre-existing prod rows). From this release it means the opposite —
// a human looked at the suggestion and said yes. The createdAt deploy boundary
// separates the two cohorts, which is why this reuses the value rather than
// adding an enum member.
// requireNonDemo: find-or-create is a NON-AI registry-write primitive — on a miss
// it mints a WineDefinition + Country/Region/Grape into the SHARED registry
// (reachable via the AddBottle/Wishlist "create new wine" flow). purgeUserData
// only reassigns createdBy on reap, so those rows would persist forever. A demo
// must never create registry entries; it can only resolve existing ones elsewhere.
// asyncHandler: the validation below runs before the try, and `?.trim()` only
// short-circuits on null/undefined — a numeric `name` threw a rejection Express 4
// never catches, so the request hung open forever with nothing but an
// unhandledRejection line in the log. Same hazard the identify-text route
// documents below; this handler was the one that still had it.
router.post('/find-or-create', requireAuth, requireNonDemo, asyncHandler(async (req, res) => {
  const { name, producer, country, region, appellation, type, grapes, labelImage, confirmCreate, source } = req.body;

  // typeof, not `?.` — see the asyncHandler note above. A non-string here must
  // be a 400, not a thrown TypeError.
  if (typeof name !== 'string' || !name.trim() || typeof producer !== 'string' || !producer.trim()) {
    return res.status(400).json({ error: 'name and producer are required' });
  }
  if (typeof country !== 'string' || !country.trim()) {
    return res.status(400).json({ error: 'country is required' });
  }
  // Cap the free-text fields that feed the O(m·n) fuzzy-match scorer. Without
  // this, a multi-MB name/producer (the body limit here is 5mb) would drive a
  // huge Levenshtein computation against every candidate — an authenticated DoS.
  // region is capped too: findOrCreateRegion mints whatever arrives, and since
  // identify-text stopped creating, this is the sole user-facing write path and
  // now receives machine-generated payloads.
  for (const [field, value] of Object.entries({ name, producer, appellation, region })) {
    if (typeof value === 'string' && value.length > MAX_WINE_FIELD) {
      return res.status(400).json({ error: `${field} must be ${MAX_WINE_FIELD} characters or fewer` });
    }
  }
  if (grapes !== undefined) {
    if (!Array.isArray(grapes) || grapes.length > MAX_GRAPES) {
      return res.status(400).json({ error: `grapes must be an array of at most ${MAX_GRAPES} entries` });
    }
    // `typeof g !== 'string' ||`, not `typeof g === 'string' &&`: the latter let a
    // non-string element straight through to isUnknownName, which calls .trim()
    // on it and 500s with the internal TypeError message.
    if (grapes.some(g => typeof g !== 'string' || g.length > MAX_WINE_FIELD)) {
      return res.status(400).json({ error: `each grape must be a string of ${MAX_WINE_FIELD} characters or fewer` });
    }
  }

  try {
    const result = await findOrCreateWine(
      { name, producer, country, region, appellation, type, grapes: grapes || [] },
      req.user.id,
      // skipSiblingMatch: the user has already reviewed the suggested matches
      // (that's what confirmCreate means here) — an appellation-variant sibling
      // must not silently override their explicit "create a new wine anyway".
      // Strict allowlist on source so an arbitrary body value can't invent a
      // provenance the enum would reject.
      { confirmCreate: !!confirmCreate, skipSiblingMatch: !!confirmCreate, createdVia: source === 'ai' ? 'ai' : 'ui' }
    );

    // Soft-zone: hand the candidates back so the UI can prompt the user
    if (result.candidates) {
      return res.status(200).json({ candidates: result.candidates });
    }

    const { wine, created } = result;
    if (created) {
      // This is the only user-facing path that mints into the SHARED registry,
      // and since identify-text went read-only it is also where AI suggestions
      // land once a user accepts them — so it was the one registry-write surface
      // with no traceable record. `createdVia` alone doesn't serve: it is
      // client-asserted and later merges rewrite it. Action name matches the MCP
      // and admin surfaces so the three read as one stream.
      logAudit(req, 'wine.create',
        { type: 'wine', id: wine._id },
        { via: source === 'ai' ? 'ai' : 'ui', name: wine.name, producer: wine.producer }
      );
      submitUrls(`/wines/${wine.slug || wine._id}`);
    }

    res.status(created ? 201 : 200).json({ wine, created });
  } catch (err) {
    console.error('Find or create wine error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to find or create wine' });
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
// Creation now happens only when the user accepts, via POST /find-or-create.
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

    if (probe.wine) {
      return res.json({ identified, match: { wine: probe.wine }, candidates: [], reason: null });
    }
    if (probe.candidates?.length) {
      return res.json({ identified, match: null, candidates: probe.candidates, reason: null });
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

router.get('/:idOrSlug/public', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    // Unauthenticated share/preview surface — quarantined non-wines are hidden
    // here for the same reason as on the OG page (code audit 2026-07-27, M5).
    // The authenticated /:id route below deliberately still resolves them, so
    // an owner's own bottle page keeps working: hiding, not breaking.
    const filter = isValidId(idOrSlug)
      ? { _id: idOrSlug, nonWine: { $ne: true } }
      : { slug: String(idOrSlug).toLowerCase(), nonWine: { $ne: true } };

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
      : { slug: String(idOrSlug).toLowerCase() };

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

router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const wine = await WineDefinition.findById(req.params.id)
      .populate(['country', 'region', 'grapes']);

    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
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
      : { slug: String(idOrSlug).toLowerCase() };

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
