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
 *
 * @param {object} payload
 * @param {object} [opts]
 * @param {boolean} [opts.allowPending=false] — the caller mints pending rows
 *   (services/findOrCreateWine allowPending), so a missing producer is a state
 *   to record, not a 400. NAME stays hard-required everywhere: a wine with no
 *   name is not an incomplete identity, it is no identity at all, and there
 *   would be nothing for a curator to research from.
 * @returns {string|null} an error message, or null when valid.
 */
function validateNewWineFields(payload, { allowPending = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'newWine must be an object';
  }
  const { name, producer, country, region, appellation, grapes, classification } = payload;
  // typeof, not `?.` — a non-string here must be a 400, not a thrown TypeError
  // inside findOrCreateWine's .trim() (the identify-text hang, audit HIGH).
  if (typeof name !== 'string' || !name.trim()) {
    return allowPending ? 'name is required' : 'name and producer are required';
  }
  if (!allowPending && (typeof producer !== 'string' || !producer.trim())) {
    return 'name and producer are required';
  }
  if (typeof country !== 'string' || !country.trim()) {
    return 'country is required';
  }
  // region is capped too: findOrCreateRegion mints whatever arrives, and this
  // path receives machine-generated payloads (accepted AI suggestions).
  // classification joins the cap for the same reason — the scan path fills it.
  for (const [field, value] of Object.entries({ name, producer, appellation, region, classification })) {
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

/** Cap on stored front/back disagreements — see validateScanConflicts. */
const MAX_SCAN_CONFLICTS = 8;

// The only field names mergeBackScan can legitimately put in a conflict —
// its MERGE_SCALARS plus 'grapes' (services/labelScan.js; mirrored rather
// than imported so this module keeps its lazy-require test seams). A free-text
// key here would be 4.8KB of attacker-chosen text rendered in the curator's
// modal and model context (release-audit LOW-2).
const CONFLICT_FIELDS = ['name', 'producer', 'vintage', 'country', 'region', 'appellation', 'type', 'grapes', 'classification'];

/**
 * Validate the front/back label disagreements the client threads back from the
 * back-label rescue scan (POST /api/wines/scan-label-back returned them).
 *
 * Client-supplied like everything else in `newWine`, so it is bounded here
 * rather than trusted: the merge that produced it compares seven scalar fields,
 * so eight entries is already more than the feature can legitimately generate,
 * and each string rides the same MAX_WINE_FIELD cap as the identity fields it
 * describes.
 *
 * @returns {Array<{field,front,back}>|null} the clean array, or null when the
 *   payload is unusable — the caller DROPS it rather than 400-ing: this is
 *   evidence attached to a bottle add, and a malformed extra must never cost
 *   the user their bottle.
 */
function validateScanConflicts(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCAN_CONFLICTS) return null;
  const clean = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const { field, front, back } = c;
    for (const v of [field, front, back]) {
      if (typeof v !== 'string' || v.length > MAX_WINE_FIELD) return null;
    }
    if (!CONFLICT_FIELDS.includes(field)) return null;
    clean.push({ field, front, back });
  }
  return clean;
}

/**
 * Attach the label photo(s) the user scanned to the registry wine they
 * produced, so curation can show a curator the actual label instead of asking
 * them to guess from three broken strings — whether the row landed in the
 * pending-identity queue or minted looking complete (see the L-5 discussion at
 * the call site: the quiet failures are the ones that most need the photo).
 *
 * Ownership-checked and single-use PER IMAGE: only the SCANNER's own label-scan
 * images, and only ones not already attached to a wine (which is also what
 * keeps them out of the 30-day unattached-scan cleanup). Two independent atomic
 * claims and ONE save() — the back scan is an optional second frame of the same
 * bottle, not a second wine, and a failed claim on one must not lose the other.
 * Best-effort by design: a failure here must never fail the user's bottle add.
 *
 * @param {object} wine   the freshly resolved/minted WineDefinition doc
 * @param {object} ids    { scanImageId?, scanImageBackId? } — client-supplied,
 *                        validated here, never trusted
 * @param {object} req
 */
async function attachScanImage(wine, { scanImageId, scanImageBackId } = {}, req) {
  try {
    if (!wine || (!scanImageId && !scanImageBackId)) return;
    const { isValidId } = require('../utils/validation');
    const BottleImage = require('../models/BottleImage');
    const { PROMOTED_SCAN_GRACE_DAYS } = require('./labelScanAccess');

    // One atomic claim: the filter is the authorization (uploader) AND the
    // single-use guard (not yet bound to a wine), so two concurrent commits
    // cannot both claim the same scan.
    const claim = async (id) => {
      // The VALIDATED string, not the raw client value: isValidId() runs on
      // String(id), so querying the original would check one thing and query
      // another (an array whose single element is a valid id stringifies past
      // the guard). Authorization is still the uploadedBy term.
      if (!id || !isValidId(String(id))) return null;
      // For a wine born PROMOTED, the retention clock starts in the SAME
      // atomic claim (release-audit LOW-1): stamping afterwards left a window
      // where a failed stamp produced an attached frame with retainUntil null
      // — skipped by the unattached sweep (it is attached) AND by the expiry
      // sweep (no date) — i.e. kept forever, unreadable. Claim-and-clock is
      // one write; the later stampPromotedScanRetention call is then an
      // idempotent no-op (it matches retainUntil: null only).
      const bornPromotedClock = wine.pendingIdentity !== true
        ? { retainUntil: new Date(Date.now() + PROMOTED_SCAN_GRACE_DAYS * 24 * 60 * 60 * 1000) }
        : {};
      const image = await BottleImage.findOneAndUpdate(
        { _id: String(id), uploadedBy: req.user.id, kind: 'label-scan', wineDefinition: null },
        { $set: { wineDefinition: wine._id, updatedAt: new Date(), ...bornPromotedClock } },
        { new: true }
      ).select('_id');
      return image ? image._id : null;
    };

    // Sequential, not Promise.all: the two claims write to the same collection
    // and the loser of a race must be observable as a null, not swallowed by a
    // rejected sibling.
    const frontId = await claim(scanImageId);
    const backId = await claim(scanImageBackId);
    if (!frontId && !backId) return;

    if (frontId) wine.scanImage = frontId;
    if (backId) wine.scanImageBack = backId;
    await wine.save();
  } catch (err) {
    console.warn('Scan-image attach failed (non-fatal):', err.message);
  }
}

/**
 * Resolve a new-wine payload to a registry wine, minting only when nothing
 * matches (or the user confirmed past the soft zone). See the module header
 * for the three return shapes. Non-400 service errors are rethrown so the
 * calling route's catch-all logs them.
 *
 * @param {object} newWine
 * @param {object} req
 * @param {object} [opts]
 * @param {boolean} [opts.allowPending=true] — this is a COMMIT path, so the
 *   default is on: an incomplete identity mints a pendingIdentity row and the
 *   user's bottle saves instantly, rather than 400-ing their add away. Pass
 *   false only from a surface that deliberately curates the shared registry.
 */
async function resolveOrMintWine(newWine, req, { allowPending = true } = {}) {
  const invalid = validateNewWineFields(newWine, { allowPending });
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
        // Scan-extracted classification line ("Grand Cru Classé en 1855") —
        // stored on creates only; before this rode along, the scan had no
        // legitimate slot for it and it landed in the NAME (ticket 6a8162c5).
        classification: newWine.classification,
        type: newWine.type,
        grapes: newWine.grapes || [],
      },
      req.user.id,
      // skipSiblingMatch with confirmCreate: the user has already reviewed the
      // suggested matches (that is what confirmCreate means) — an appellation-
      // variant sibling must not silently override their explicit "create a
      // new wine anyway". Same semantics the find-or-create route had.
      { confirmCreate: !!newWine.confirmCreate, skipSiblingMatch: !!newWine.confirmCreate, createdVia: via, allowPending }
    );
  } catch (err) {
    // The service's mint gates (unrecognized country, place-as-producer,
    // unusable producer) throw status-400 errors — client faults, surfaced as
    // such. Anything else is a real failure: rethrow for the route's catch.
    if (err && err.status === 400) return { error: { status: 400, message: err.message } };
    throw err;
  }

  if (result.candidates) return { candidates: result.candidates };

  // Release-audit LOW-2: findOrCreateWine's E11000 recovery re-queries by
  // normalizedKey only — a same-slug/different-key sub-second race can return
  // { wine: null }. Both consumers would deref it into a 500; a clean 409
  // self-heals on retry (the winner is committed by then).
  if (!result.wine) {
    return { error: { status: 409, message: 'Wine resolution raced with another write — please retry.' } };
  }

  const { wine, created } = result;
  const pendingIdentity = wine.pendingIdentity === true;
  if (created) {
    // Same action string + detail shape the find-or-create route emitted (and
    // the MCP/admin/import surfaces emit), so registry writes keep reading as
    // ONE audit stream (2026-08-03 M-1). `createdVia` alone doesn't serve: it
    // is client-asserted and later merges rewrite it.
    logAudit(req, 'wine.create',
      { type: 'wine', id: wine._id },
      {
        via, name: wine.name, producer: wine.producer || null,
        ...(pendingIdentity ? { pendingIdentity: true } : {}),
        // A producer the cross-field rules refused at mint time is NOT stored
        // on the row (the wine keys pending with producer ''), so the audit
        // entry is the only place the original string survives — which is what
        // lets a curator see WHAT the scan read, and an admin see the rule that
        // caught it. findOrCreateWine sets this on creates only.
        ...(result.producerRejected
          ? {
              rejectedProducer: result.producerRejected.producer,
              rejectedByCheck: result.producerRejected.check,
            }
          : {}),
      }
    );
    // A pending row has no public wine page to announce — it 404s for everyone
    // but its creator, so pinging IndexNow would advertise a dead URL. The
    // promotion path submits it instead.
    if (!pendingIdentity) submitUrls(`/wines/${wine.slug || wine._id}`);
  }
  // Stamp the label scan on EVERY scan-originated mint — and on the creator's
  // OWN pending row that has none yet, which is how a second bottle of the same
  // unidentified wine can still supply the photo the first add didn't have.
  //
  // L-5 (data minimisation) REVISITED, honestly. The rule used to be PENDING
  // ONLY, on the argument that a fully-identified wine needs no evidence. Prod
  // 2026-08-13 disproved the premise: the wines whose scan errors need a label
  // to settle are precisely the ones that came back looking complete —
  // "Chardonnay Reserve" by "Pays d'Oc Organic Wine" minted as an ordinary
  // published row, and a curator meeting it later had a plausible-looking
  // record, no photo, and no way to tell. A scan that fails LOUDLY leaves
  // evidence; a scan that fails QUIETLY left none. That is the wrong way round.
  //
  // So the purpose exists for both populations, and the WINDOW is what bounds
  // it — not queue membership:
  //   pending row      → retainUntil stays null (no clock while the queue is the
  //                      purpose); the promotion hook stamps it on the way out.
  //   non-pending mint → stamped here, immediately: the wine was born promoted,
  //                      so its correction window starts at birth. Same
  //                      PROMOTED_SCAN_GRACE_DAYS, same sweep, same deletion.
  // GDPR posture is unchanged: same data category (a private kind:'label-scan'
  // photo of the user's own bottle), no new consent, already covered by
  // GET /api/users/me/export and the account-deletion cascade (both key on
  // uploadedBy, not on the wine's state — services/userDataRegistry), and
  // deleted by the same two sweeps in services/scanImageRetentionJob. The net
  // effect is BOUNDED retention where there was previously none at all: before
  // this, a non-pending mint's frame was left unattached and swept at 30 days;
  // it is now attached and swept at 7.
  //
  // The RESOLVE branch keeps its pending-only gate deliberately: backfilling a
  // photo onto an existing published wine somebody else may have created is a
  // different act with a different owner, and nothing has asked for it.
  //
  // The BACK scan and the front/back conflicts ride the SAME gate, deliberately:
  // they are the same evidence about the same label, so a condition that let one
  // through and not the other would store a photo whose explanation is missing
  // (or the reverse). The back frame is optional — a commit may carry only the
  // front, only the back (the front scan 422'd and its frame was abandoned), or
  // both.
  if ((newWine.scanImageId || newWine.scanImageBackId)
      && (created
        || (pendingIdentity && String(wine.createdBy) === String(req.user.id)
            && !wine.scanImage && !wine.scanImageBack))) {
    await attachScanImage(
      wine,
      { scanImageId: newWine.scanImageId, scanImageBackId: newWine.scanImageBackId },
      req
    );
    // Stored only alongside the evidence it explains: "front said X, back said
    // Y" is a statement ABOUT those photos and cannot be checked without them.
    const conflicts = validateScanConflicts(newWine.scanConflicts);
    if (conflicts && (wine.scanImage || wine.scanImageBack)
        && (!wine.scanFieldConflicts || wine.scanFieldConflicts.length === 0)) {
      try {
        wine.scanFieldConflicts = conflicts;
        await wine.save();
      } catch (err) {
        console.warn('Scan-conflict record failed (non-fatal):', err.message);
      }
    }
    // Start the retention clock on a wine that was born PROMOTED. The
    // post('save') hook in models/WineDefinition only fires on the
    // pending→promoted TRANSITION, which a row that was never pending never
    // makes — so without this the frame would be attached, readable, and on no
    // clock at all: exactly the "worst of both worlds" state
    // services/labelScanAccess exists to end. Idempotent and best-effort by
    // construction (it matches retainUntil: null and swallows its own errors),
    // and a no-op for a pending row, whose clock must not start yet.
    if (!pendingIdentity && (wine.scanImage || wine.scanImageBack)) {
      const { stampPromotedScanRetention } = require('./labelScanAccess');
      await stampPromotedScanRetention(wine);
    }
  }
  return { wine, created: !!created, pendingIdentity };
}

module.exports = {
  resolveOrMintWine, validateNewWineFields, attachScanImage, validateScanConflicts,
  MAX_WINE_FIELD, MAX_GRAPES, MAX_SCAN_CONFLICTS,
};
