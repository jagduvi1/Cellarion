/**
 * wineCommit — resolve-or-mint a registry wine INSIDE a user's committing
 * write (bottle add, wishlist add). The shared implementation behind the
 * `newWine` branch of POST /api/bottles and POST /api/wishlist.
 *
 * Third verse of the mint-before-commitment cleanup, same shape as the two
 * prior fixes:
 *   - v1.97: POST /api/wines/identify-text minted a WineDefinition per AI
 *     guess; measured on prod 2026-08-03, 85 of 162 createdVia:'ai' rows had
 *     zero bottles (52%). It is now read-only; see routes/wines.js.
 *   - v1.100.0 (#899): bottle import minted on /validate; /validate is now
 *     registry-read-only and wines mint on /confirm. See routes/import.js.
 *   - This one: the AddBottle/AddToWishlist UI minted on step-1 confirm via
 *     POST /api/wines/find-or-create, before any bottle existed. Measured on
 *     prod 2026-08-10: 31 zero-bottle createdVia:'ui' rows; the same day a
 *     user minted "Domaine de Riquewihr — Kaefferkopf" (village-as-producer,
 *     likely fictitious) and two minutes later attached their bottle to a
 *     DIFFERENT existing wine — the orphan would have sat in the shared
 *     registry forever. The mint now happens here, inside the commit, so an
 *     abandoned form leaves nothing behind.
 *
 * Contract (mirrors the old find-or-create route exactly, so the UI's
 * soft-zone dialog logic carries over unchanged):
 *   resolveOrMintWine(newWine, req) →
 *     { error: { status, message } }   — client fault (validation, mint gates)
 *     { candidates: [{ wine, score }]} — dedup soft zone; NOTHING was created.
 *                                        The caller re-submits with either an
 *                                        existing wine id or confirmCreate:true.
 *     { wine, created }                — resolved (created:false) or minted
 *                                        (created:true, audited + IndexNow'd)
 *
 * newWine shape: { name, producer, country, region?, appellation?, type?,
 *   grapes?: string[], confirmCreate?: boolean, source?: 'ai' } — the exact
 *   payload POST /api/wines/find-or-create took when it still created.
 *   `source:'ai'` marks "the user accepted an AI suggestion" and stamps
 *   createdVia:'ai'; anything else stamps 'ui' (strict allowlist, so a body
 *   value can't invent a provenance the enum would reject).
 */

const { logAudit } = require('./audit');
const { submitUrls } = require('./indexNow');

// Field caps for anything that reaches the registry-write path. One source of
// truth (imported by routes/wines.js too) mirroring what findOrCreateWine
// enforces at its own create chokepoint — kept here as REQUEST validation so a
// multi-MB name/producer never reaches the O(m·n) fuzzy-match scorer
// (authenticated DoS; same rationale as the old find-or-create route).
const MAX_WINE_FIELD = 200;
const MAX_GRAPES = 20;

/**
 * Validate a new-wine payload against the caps the old find-or-create route
 * enforced — extracted rather than duplicated, so the resolve endpoint and
 * both commit endpoints can never drift.
 * @returns {string|null} an error message, or null when valid.
 */
function validateNewWineFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'newWine must be an object';
  }
  const { name, producer, country, region, appellation, grapes } = payload;
  // typeof, not `?.` — a non-string here must be a 400, not a thrown TypeError
  // inside findOrCreateWine's .trim() (the identify-text hang, audit HIGH).
  if (typeof name !== 'string' || !name.trim() || typeof producer !== 'string' || !producer.trim()) {
    return 'name and producer are required';
  }
  if (typeof country !== 'string' || !country.trim()) {
    return 'country is required';
  }
  // region is capped too: findOrCreateRegion mints whatever arrives, and this
  // path receives machine-generated payloads (accepted AI suggestions).
  for (const [field, value] of Object.entries({ name, producer, appellation, region })) {
    if (typeof value === 'string' && value.length > MAX_WINE_FIELD) {
      return `${field} must be ${MAX_WINE_FIELD} characters or fewer`;
    }
  }
  if (grapes !== undefined) {
    if (!Array.isArray(grapes) || grapes.length > MAX_GRAPES) {
      return `grapes must be an array of at most ${MAX_GRAPES} entries`;
    }
    // `typeof g !== 'string' ||`, not `typeof g === 'string' &&`: the latter
    // let a non-string element through to isUnknownName's .trim() → 500.
    if (grapes.some(g => typeof g !== 'string' || g.length > MAX_WINE_FIELD)) {
      return `each grape must be a string of ${MAX_WINE_FIELD} characters or fewer`;
    }
  }
  return null;
}

/**
 * Resolve a new-wine payload to a registry wine, minting only when nothing
 * matches (or the user confirmed past the soft zone). See the module header
 * for the three return shapes. Non-400 service errors are rethrown so the
 * calling route's catch-all logs them.
 */
async function resolveOrMintWine(newWine, req) {
  const invalid = validateNewWineFields(newWine);
  if (invalid) return { error: { status: 400, message: invalid } };

  const via = newWine.source === 'ai' ? 'ai' : 'ui';

  // Lazy require: findOrCreateWine top-requires services/search → the
  // ESM-only meilisearch package jest cannot parse (the #702 failure mode).
  const { findOrCreateWine } = require('./findOrCreateWine');
  let result;
  try {
    result = await findOrCreateWine(
      {
        name: newWine.name,
        producer: newWine.producer,
        country: newWine.country,
        region: newWine.region,
        appellation: newWine.appellation,
        type: newWine.type,
        grapes: newWine.grapes || [],
      },
      req.user.id,
      // skipSiblingMatch with confirmCreate: the user has already reviewed the
      // suggested matches (that is what confirmCreate means) — an appellation-
      // variant sibling must not silently override their explicit "create a
      // new wine anyway". Same semantics the find-or-create route had.
      { confirmCreate: !!newWine.confirmCreate, skipSiblingMatch: !!newWine.confirmCreate, createdVia: via }
    );
  } catch (err) {
    // The service's mint gates (unrecognized country, place-as-producer,
    // unusable producer) throw status-400 errors — client faults, surfaced as
    // such. Anything else is a real failure: rethrow for the route's catch.
    if (err && err.status === 400) return { error: { status: 400, message: err.message } };
    throw err;
  }

  if (result.candidates) return { candidates: result.candidates };

  const { wine, created } = result;
  if (created) {
    // Same action string + detail shape the find-or-create route emitted (and
    // the MCP/admin/import surfaces emit), so registry writes keep reading as
    // ONE audit stream (2026-08-03 M-1). `createdVia` alone doesn't serve: it
    // is client-asserted and later merges rewrite it.
    logAudit(req, 'wine.create',
      { type: 'wine', id: wine._id },
      { via, name: wine.name, producer: wine.producer }
    );
    submitUrls(`/wines/${wine.slug || wine._id}`);
  }
  return { wine, created: !!created };
}

module.exports = { resolveOrMintWine, validateNewWineFields, MAX_WINE_FIELD, MAX_GRAPES };
