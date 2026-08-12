/**
 * pendingWineOps — the pending-identity curation queue, ONE implementation for
 * the REST somm routes (routes/somm/pendingWines.js) and the MCP somm tools
 * (mcp/tools/somm.js), so the two surfaces cannot drift on projection,
 * anonymisation, taxonomy resolution or conflict semantics. Same shape as
 * services/ownerInquiryOps (#930) and services/wineProfileOps.
 *
 * What is in the queue: WineDefinitions minted at bottle-commit from an
 * incomplete identity — no producer, a sentinel producer, or a geography typed
 * into the producer box (models/WineDefinition.pendingIdentity). They are
 * invisible to everyone but their creator until a curator completes them.
 *
 * ANONYMISED, deliberately (the #930 rule): the row carries the wine, its
 * bottle count and its IMAGES — never the creator's id, username or email. A
 * curator fixes a record; who owns the bottle is not part of that judgement,
 * and the queue is reachable over MCP, where the payload leaves the building.
 *
 * The FIX is a plain field write. Promotion is not done here and must not be:
 * the WineDefinition pre-validate hook flips pendingIdentity off as soon as
 * producer + name are both real, so every write path promotes identically.
 * What IS done here is the follow-through a promotion needs — search index,
 * embeddings, maturity queue, IndexNow — because a row that was excluded from
 * all four while pending has to be let back in exactly once.
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Country = require('../models/Country');
// pendingWineKey comes from utils/normalize (beside generateWineKey), NOT from
// services/findOrCreateWine: one definition of the key shape, and no dependency
// from the curation queue onto the resolver's module tree to build a string.
const { generateWineKey, pendingWineKey, normalizeAppellation, normalizeString, resolveCountryName, isIdentitySentinel, isImplausibleIdentity } = require('../utils/normalize');
const { IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS, resolveCrossFieldCheck } = require('../utils/crossFieldChecks');
// Top-level: labelScanAccess requires nothing at load (its own model require is
// lazy), so it adds no module tree to the curation queue.
const { stampPromotedScanRetention } = require('./labelScanAccess');
const { resolveGrapeIdsStrict, GRAPES_MAX, GRAPE_NAME_MAX, WINE_TYPES } = require('./wineProfileOps');

// Fields a curator may set. `producer` and `name` are the two that promote the
// row; the rest ride along so one pass can fix everything the misread label
// got wrong. Deliberately NOT here: type-only/profile fields (set_wine_profile
// owns those), nonWine (a quarantine proposal), and anything about the bottle.
const FIXABLE_FIELDS = ['producer', 'name', 'appellation', 'regionName', 'countryName', 'grapeNames', 'type', 'identityUnavailable'];
/**
 * Not a field — an explicit, audited OVERRIDE of the cross-field refusal below.
 *
 * Why it has to exist (audit L-10b): the gate refuses a producer that matches a
 * Region or Appellation document, and users can MINT those. A junk Region
 * called "Ferreirinha" or an appellation promoted from a misread label makes
 * that real producer's name permanently unwritable — and the only escape the
 * curator had left was `identityUnavailable`, i.e. RECORDING A FALSEHOOD ("the
 * label prints no producer") about a wine whose label prints it plainly. A hard
 * refusal with no override is how a data-quality rule starts manufacturing bad
 * data.
 *
 * Deliberately separate from FIXABLE_FIELDS: it writes nothing, it is never
 * echoed back as a value, and it must not count towards "did the curator send
 * anything to change?".
 */
const CROSS_FIELD_OVERRIDE_FIELD = 'crossFieldOverride';
const FIELD_MAX = 200;
// Up to three bottle photos per wine — enough for a curator to cross-read a
// label, small enough to keep an MCP image response inside its size cap.
const MAX_BOTTLE_IMAGES = 3;

/** Provenance values worth filtering a burst by (createdVia enum minus null). */
const CREATED_VIA_FILTERS = ['ui', 'import', 'mcp', 'ai'];

/**
 * One queue page, newest first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {number} [opts.offset=0]
 * @param {boolean} [opts.includeUnavailable=false] show the rows a curator has
 *   dispositioned "no producer on the label"
 *   (models/WineDefinition.identityUnavailable). Excluded by default because
 *   this queue is a list of WORK and those rows have none left; they are still
 *   pending, still hidden from the registry, and one filter click away — the
 *   disposition is reversible and must stay visible to be reversed.
 * @param {string} [opts.createdVia] one of CREATED_VIA_FILTERS — the filter
 *   that makes a big import burst workable: 500 rows from one CSV are one
 *   `createdVia:'import'` sweep, and a curator can leave them for a batch
 *   session while still clearing the trickle of 'ui' scans. (Grouping by
 *   import session was the alternative; ImportSession is deleted the moment an
 *   import finishes, so there would be nothing left to group by.)
 * @returns {{ rows, total, pendingTotal, unavailableTotal }}
 */
async function queryPendingWines({ limit = 20, offset = 0, createdVia = null, includeUnavailable = false } = {}) {
  const filter = { pendingIdentity: true };
  if (!includeUnavailable) filter.identityUnavailable = { $ne: true };
  // Literal from the static array, never raw input (CodeQL query-injection
  // rule, the aiBudgetRequests pattern).
  const viaIdx = CREATED_VIA_FILTERS.indexOf(String(createdVia || ''));
  if (viaIdx !== -1) filter.createdVia = CREATED_VIA_FILTERS[viaIdx];

  const [wines, total, pendingTotal, unavailableTotal] = await Promise.all([
    WineDefinition.find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name')
      .lean(),
    WineDefinition.countDocuments(filter),
    // The WORK figure: rows still awaiting an identity, excluding the ones a
    // curator has already dispositioned. Counted separately below so the UI can
    // still say how many of those there are.
    WineDefinition.countDocuments({ pendingIdentity: true, identityUnavailable: { $ne: true } }),
    WineDefinition.countDocuments({ pendingIdentity: true, identityUnavailable: true }),
  ]);

  const ids = wines.map((w) => w._id);
  // Bottles first: they give the count AND the id set the photos hang off.
  // Photos are matched BOTH ways — some upload paths stamp wineDefinition on
  // the image, the plain AddBottle flow only links it to the bottle — because
  // a curator missing the one photo that shows the label defeats the queue.
  const bottles = ids.length
    ? await Bottle.find({ wineDefinition: { $in: ids } }).select('_id wineDefinition').lean()
    : [];
  const wineByBottle = new Map(bottles.map((b) => [String(b._id), String(b.wineDefinition)]));
  const countBy = new Map();
  for (const b of bottles) {
    const key = String(b.wineDefinition);
    countBy.set(key, (countBy.get(key) || 0) + 1);
  }

  const bottleImages = ids.length
    ? await BottleImage.find({
      kind: { $ne: 'label-scan' },
      $or: [
        { wineDefinition: { $in: ids } },
        ...(bottles.length ? [{ bottle: { $in: bottles.map((b) => b._id) } }] : []),
      ],
    })
      .select('wineDefinition bottle createdAt originalUrl processedUrl')
      .sort({ createdAt: -1 })
      .limit(ids.length * MAX_BOTTLE_IMAGES * 4)
      .lean()
    : [];

  const imagesBy = new Map();
  for (const img of bottleImages) {
    const key = img.wineDefinition
      ? String(img.wineDefinition)
      : wineByBottle.get(String(img.bottle));
    if (!key) continue;
    const list = imagesBy.get(key) || [];
    if (list.length < MAX_BOTTLE_IMAGES) list.push(img);
    imagesBy.set(key, list);
  }

  // Scan images are fetched separately: the wine points AT one, so there is no
  // wineDefinition/bottle link to find it by.
  const scanIds = wines.map((w) => w.scanImage).filter(Boolean);
  const scans = scanIds.length
    ? await BottleImage.find({ _id: { $in: scanIds } }).select('originalUrl processedUrl').lean()
    : [];
  // id → on-disk URL, for the WEB queue's thumbnails. The bytes are served by
  // the unauthenticated random-UUID static mount (app.js), so an <img> can
  // render them directly — this map exists because an id alone cannot. The MCP
  // projection drops it: a model gets pixels from get_pending_wine_images, and
  // a URL it cannot fetch would be noise in the payload.
  const imageUrls = {};
  for (const img of [...scans, ...bottleImages]) {
    const url = img.originalUrl || img.processedUrl;
    if (url) imageUrls[String(img._id)] = url;
  }

  const rows = wines.map((w) => {
    const bottleImageIds = (imagesBy.get(String(w._id)) || []).map((i) => String(i._id));
    const scanImageId = w.scanImage ? String(w.scanImage) : null;
    // Scoped to THIS row's ids — a shared map repeated on 25 rows is 25 copies
    // of the same payload.
    const urls = {};
    for (const id of [scanImageId, ...bottleImageIds]) {
      if (id && imageUrls[id]) urls[id] = imageUrls[id];
    }
    return {
      _id: w._id,
      name: w.name,
      // '' is how a missing producer is stored — surfaced as null so no client
      // renders an empty quoted string as if it were a value.
      producer: w.producer || null,
      appellation: w.appellation || null,
      regionName: w.region?.name || null,
      countryName: w.country?.name || null,
      grapeNames: (w.grapes || []).map((g) => g.name).filter(Boolean),
      type: w.type || null,
      identityUnavailable: w.identityUnavailable === true,
      createdAt: w.createdAt,
      createdVia: w.createdVia || null,
      bottleCount: countBy.get(String(w._id)) || 0,
      // The point of the whole feature: the label the curator has to read.
      scanImageId,
      bottleImageIds,
      imageUrls: urls,
      // NO creator field, by design — see the module header.
    };
  });

  return { rows, total, pendingTotal, unavailableTotal };
}

/**
 * Validate a curator's patch. Returns { ok, clean } or { ok:false, error }.
 * Shape-only — taxonomy names are resolved in applyPendingFix, which needs the
 * wine document.
 */
function validatePendingFix(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'A patch object is required' };
  }
  const clean = {};
  for (const field of FIXABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === 'grapeNames') {
      const g = patch.grapeNames;
      if (!Array.isArray(g) || g.length > GRAPES_MAX) {
        return { ok: false, error: `grapeNames must be an array of at most ${GRAPES_MAX} variety names` };
      }
      if (g.some((n) => typeof n !== 'string' || !n.trim() || n.length > GRAPE_NAME_MAX)) {
        return { ok: false, error: `each grape name must be a non-empty string of at most ${GRAPE_NAME_MAX} characters` };
      }
      clean.grapeNames = g.map((n) => n.trim());
      continue;
    }
    if (field === 'type') {
      if (!WINE_TYPES.includes(patch.type)) {
        return { ok: false, error: `type must be one of: ${WINE_TYPES.join(', ')}` };
      }
      clean.type = patch.type;
      continue;
    }
    if (field === 'identityUnavailable') {
      // A disposition, not a value — strictly boolean so `false` (the UNDO)
      // survives the loop instead of being read as "unset".
      if (typeof patch.identityUnavailable !== 'boolean') {
        return { ok: false, error: 'identityUnavailable must be true or false' };
      }
      clean.identityUnavailable = patch.identityUnavailable;
      continue;
    }
    if (typeof patch[field] !== 'string') {
      return { ok: false, error: `${field} must be a string` };
    }
    const v = patch[field].trim().replace(/\s+/g, ' ');
    if (v.length > FIELD_MAX) {
      return { ok: false, error: `${field} must be at most ${FIELD_MAX} characters` };
    }
    // An empty string clears an optional field; producer and name cannot be
    // cleared — clearing them is what the row already is.
    if (!v && (field === 'producer' || field === 'name')) {
      return { ok: false, error: `${field} cannot be emptied — this queue exists to FILL it` };
    }
    clean[field] = v;
  }
  if (Object.keys(clean).length === 0) {
    return { ok: false, error: `Nothing to change — send at least one of: ${FIXABLE_FIELDS.join(', ')}` };
  }
  // Checked AFTER the "nothing to change" test on purpose: an override on its
  // own changes nothing and is not a request.
  if (patch[CROSS_FIELD_OVERRIDE_FIELD] !== undefined) {
    if (typeof patch[CROSS_FIELD_OVERRIDE_FIELD] !== 'boolean') {
      return { ok: false, error: `${CROSS_FIELD_OVERRIDE_FIELD} must be true or false` };
    }
    if (patch[CROSS_FIELD_OVERRIDE_FIELD] === true && !clean.producer) {
      return {
        ok: false,
        error: `${CROSS_FIELD_OVERRIDE_FIELD} only applies to a producer write — send the producer it should override`,
      };
    }
    clean[CROSS_FIELD_OVERRIDE_FIELD] = patch[CROSS_FIELD_OVERRIDE_FIELD];
  }
  return { ok: true, clean };
}

/**
 * Apply a validated patch to a pending wine and run the promotion
 * follow-through when the identity became complete.
 *
 * Taxonomy is resolved with the SAME semantics as approving a correction
 * proposal (routes/admin/wineProposals.js): appellation normalized, country
 * RESOLVED never minted, region through the gated findOrCreateRegion, grapes
 * match-only against the taxonomy, normalizedKey regenerated when any of
 * name/producer/appellation moved.
 *
 * @returns {{ ok:true, wine, promoted, diff }} | {{ ok:false, code, message }}
 */
async function applyPendingFix(wine, clean, userId) {
  const before = {
    producer: wine.producer || null,
    name: wine.name,
    appellation: wine.appellation || null,
    type: wine.type || null,
    identityUnavailable: wine.identityUnavailable === true,
  };

  if (clean.name) wine.name = clean.name;
  if (clean.producer) wine.producer = clean.producer;
  // The "no producer on the label" disposition. Deliberately NOT a promotion:
  // pendingIdentity stays true and every exclusion it carries stays in force —
  // the row simply leaves the WORK list (see the field comment on
  // models/WineDefinition.identityUnavailable). Reversible with `false`.
  if (clean.identityUnavailable !== undefined) {
    wine.identityUnavailable = clean.identityUnavailable;
  }

  // SHAPE gate, before any DB work. The same predicate the auto-promote hook
  // uses, so a fix the hook would silently decline to promote is refused here
  // with a reason instead — a curator whose write "succeeded" but left the row
  // in the queue with no explanation is how the "Increíble"/"Increíble" class
  // gets retried rather than corrected.
  if ((clean.producer || clean.name) && isImplausibleIdentity(wine.producer, wine.name)) {
    return {
      ok: false,
      code: 'invalid_input',
      message:
        `"${wine.producer}" is not a usable producer for "${wine.name}" — it carries no winery distinct from the ` +
        'wine name, so nothing in the record says who made it. Read the label photo and write the winery as printed; ' +
        'if the label genuinely prints no producer, mark the row identity-unavailable instead of guessing.',
    };
  }
  if (clean.appellation !== undefined) {
    wine.appellation = clean.appellation ? normalizeAppellation(clean.appellation) : null;
  }
  if (clean.type) wine.type = clean.type;

  let countryDoc = null;
  if (clean.countryName !== undefined && clean.countryName) {
    // Alias → canonical name → EXISTING Country doc. Unresolvable is a client
    // fault, never a minted Country: taxonomy grows deliberately, not through
    // a queue click (wineProposals approve, verbatim).
    countryDoc = await Country.findOne({ normalizedName: normalizeString(resolveCountryName(clean.countryName)) });
    if (!countryDoc) {
      return {
        ok: false,
        code: 'invalid_input',
        message: `Unknown country "${clean.countryName}" — add it in Admin → Taxonomy first, then fix this wine`,
      };
    }
    wine.country = countryDoc._id;
  }
  if (clean.regionName !== undefined) {
    if (!clean.regionName) {
      wine.region = null;
    } else {
      // Lazy require: findOrCreateWine top-requires services/search → the
      // ESM-only meilisearch package jest cannot parse (the #702 failure mode).
      const { findOrCreateRegion } = require('./findOrCreateWine');
      const regionDoc = await findOrCreateRegion(clean.regionName, countryDoc?._id || wine.country, userId);
      wine.region = regionDoc?._id || null;
    }
  }
  let grapeNames = null;
  if (clean.grapeNames !== undefined) {
    if (clean.grapeNames.length === 0) {
      wine.grapes = [];
      grapeNames = [];
    } else {
      const resolved = await resolveGrapeIdsStrict(clean.grapeNames);
      if (!resolved.ok) {
        return {
          ok: false,
          code: 'invalid_input',
          message: `Not in the grape taxonomy: ${resolved.unmatched.join(', ')}. Synonyms resolve ("Shiraz" finds Syrah) — a genuinely new variety needs an admin taxonomy add first.`,
        };
      }
      wine.grapes = resolved.ids;
      grapeNames = resolved.names;
    }
  }

  // CROSS-FIELD gate — the half of "is this a real identity?" that needs the
  // taxonomy collections and therefore cannot live in the model's pre-validate
  // hook. "Tokaji", "Chablis", "Syrah", "Roșu Demidulce" and "Domaine unknown"
  // are all strings a label scan puts in the producer box, and a curator
  // completing the row from a bad OCR guess would put them in the SHARED
  // registry with a 45% dedup weight. The rules are the existing ones
  // (utils/crossFieldChecks), restricted to the producer-is-not-a-producer
  // family — see IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS for why the
  // formatting rules stay review-only.
  //
  // Run when the producer was written, or when this save would PROMOTE (the
  // hook's own predicate, predicted here exactly as the key regen below does) —
  // never on an appellation-only touch-up of a row staying in the queue.
  const willPromote = !isIdentitySentinel(wine.producer) && !isIdentitySentinel(wine.name) &&
    !isImplausibleIdentity(wine.producer, wine.name);
  //
  // OVERRIDABLE, explicitly and audibly (audit L-10b). The rules read the LIVE
  // taxonomy, and users can mint Regions and Appellations — so a junk Region
  // doc bearing a real producer's name makes that producer permanently
  // unwritable, and the only remaining escape (identityUnavailable) records
  // something FALSE about a label that plainly prints it. A curator who can see
  // the label may say so with crossFieldOverride; the override is refused
  // unless a producer is actually being written, it is never a default, and the
  // caller logs it — see the audit metadata in routes/somm/pendingWines.js and
  // mcp/tools/somm.fix_pending_wine.
  let crossFieldOverridden = null;
  if (clean.producer !== undefined || willPromote) {
    // Lazy require, same reason as findOrCreateRegion above: keep the curation
    // queue off the resolver/search module tree at load time.
    const { detectCrossFieldForValues } = require('./crossFieldScan');
    const hits = await detectCrossFieldForValues({
      name: wine.name,
      producer: wine.producer,
      appellation: wine.appellation,
    }, IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS);
    if (hits && hits.length) {
      const hit = hits[0];
      const check = resolveCrossFieldCheck(hit.check);
      if (clean[CROSS_FIELD_OVERRIDE_FIELD] !== true) {
        return {
          ok: false,
          code: 'invalid_input',
          message:
            `Refused by cross-field rule ${hit.check}: "${hit.detail}" is not a producer — it belongs in a different ` +
            `field${check ? ` (the flagged field is "${check.field}")` : ''}. Read the label photo and write the ` +
            'winery as printed; a place, a grape, a style term or a placeholder in the producer box would spread ' +
            'through the shared registry, where the producer is 45% of the duplicate score. If the label genuinely ' +
            'prints no producer, mark the row identity-unavailable instead. If the label DOES print this name and ' +
            'the taxonomy is what is wrong (a user-minted region or appellation carrying a real producer\'s name), ' +
            `resend with ${CROSS_FIELD_OVERRIDE_FIELD}: true — that is recorded against your account.`,
        };
      }
      // Returned to the caller so the override lands in the audit log with the
      // rule it overrode, not as a bare boolean nobody can interpret later.
      crossFieldOverridden = hits.map((h) => ({ check: h.check, detail: String(h.detail) }));
    }
  }

  // Same rule as the admin PUT and the proposal approve: the dedup key follows
  // name/producer/appellation. Regenerating it here is also what moves a
  // promoted row OUT of the pending key namespace (pending~<creator>:…) and
  // into the ordinary one, where the unique index re-checks it.
  //
  // …but ONLY when the row is actually leaving. `wine.pendingIdentity` is still
  // true at this point (the pre-validate hook flips it during save below), so
  // this must PREDICT the hook with the hook's own predicate rather than read
  // the flag. Using generateWineKey unconditionally dropped the creator id out
  // of a STILL-PENDING row's key (security audit M-2), breaking the documented
  // namespace invariant: two curator-renamed pending rows by different users
  // could then land on the same ordinary key and E11000 into a "merge them
  // instead" 409 that is simply false.
  // …computed once above (it also decides whether the cross-field gate runs),
  // and it now carries the hook's implausibility term too — a row the hook
  // refuses to promote must keep its per-creator pending key.
  if (clean.name || clean.producer || clean.appellation !== undefined) {
    wine.normalizedKey = willPromote
      ? generateWineKey(wine.name, wine.producer, wine.appellation)
      : pendingWineKey(wine.name, wine.createdBy, wine.appellation);
  }

  // The pre-validate hook promotes; read the outcome rather than deciding it.
  try {
    await wine.save();
  } catch (err) {
    if (err.code === 11000) {
      return {
        ok: false,
        code: 'conflict',
        message: 'This fix would make the wine identical to an existing registry wine — merge them instead (the registry already holds that identity).',
      };
    }
    if (err?.name === 'VersionError') {
      return { ok: false, code: 'conflict', message: 'The wine changed mid-write — retry.' };
    }
    throw err;
  }

  const promoted = wine.pendingIdentity !== true;
  if (promoted) {
    await runPromotionFollowThrough(wine);
  }

  const after = {
    producer: wine.producer || null,
    name: wine.name,
    appellation: wine.appellation || null,
    type: wine.type || null,
    identityUnavailable: wine.identityUnavailable === true,
  };
  const diff = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) diff[k] = { from: before[k], to: after[k] };
  }
  if (clean.countryName !== undefined) diff.country = { to: clean.countryName || null };
  if (clean.regionName !== undefined) diff.region = { to: clean.regionName || null };
  if (grapeNames !== null) diff.grapes = { to: grapeNames };

  return { ok: true, wine, promoted, diff, grapeNames, crossFieldOverridden };
}

/**
 * Everything a wine was excluded from while pending, let back in — exactly
 * once, right here, so no caller has to remember the list.
 *
 * All best-effort: the fix itself is committed, and none of these may fail it.
 */
async function runPromotionFollowThrough(wine) {
  // The label scan's clock starts HERE. While the row was pending the scan was
  // curation evidence with a live purpose; promotion ends that purpose, but not
  // instantly — a wrong completion has to be correctable against the label,
  // which under the old rule became unreadable the moment the row left the
  // queue (services/labelScanAccess). So the scan stays readable for
  // PROMOTED_SCAN_GRACE_DAYS and is then deleted, file and doc, by the daily
  // sweep. GDPR: this REDUCES retention — a promoted wine's scan was previously
  // kept indefinitely, reachable by nobody.
  //
  // The stamp itself now lives on the TRANSITION — a post('save') hook on
  // WineDefinition — because "every promoting caller runs this follow-through"
  // was simply false: the admin PUT and /strip-producer promote by setting a
  // producer and saving, and called nothing (audit M-4). Kept here as well,
  // deliberately: the update matches `retainUntil: null` and so cannot extend a
  // live deadline, and this call is what the curation path's own test asserts.
  await stampPromotedScanRetention(wine);
  const searchService = require('./search');
  // indexWine owns index membership in BOTH directions — this is the call that
  // ADDS the promoted row (it removed it while pending).
  searchService.indexWine(wine._id).catch?.(() => {});
  // Bottles carry a denormalized copy of the wine's identity in their own
  // index; a producer that just appeared has to reach them too (no scheduled
  // resync exists — same reasoning as the proposal-approve path).
  Bottle.distinct('_id', { wineDefinition: wine._id })
    .then((ids) => searchService.bulkIndexBottles(ids))
    .catch((err) => console.error('Bottle re-index after pending promotion failed:', err.message));
  // Never embedded while pending — embed now, for the vintages that exist.
  require('./embeddingJob').reembedActiveVintages(wine._id).catch(() => {});
  // Never enriched while pending either (services/enrichmentJob) — the wine now
  // HAS a producer, so a tasting profile can finally be about something. No
  // budgetUserId: this is curation work, not a user action, so it is not
  // debited to whoever happened to add the bottle.
  require('./enrichmentJob').enrichWineById(wine._id).catch?.(() => {});
  // The maturity queue refused to seed this wine while pending; seed it from
  // the bottles that are already in cellars, so the drink windows the owners
  // are waiting for finally get curated.
  try {
    const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
    const vintages = await Bottle.distinct('vintage', { wineDefinition: wine._id, status: 'active' });
    for (const v of vintages) await ensurePendingVintageProfile(wine._id, v);
  } catch (err) {
    console.warn('Maturity re-seed after pending promotion failed (non-fatal):', err.message);
  }
  // The wine now has a public page worth announcing (it 404'd while pending).
  try {
    require('./indexNow').submitUrls(`/wines/${wine.slug || wine._id}`);
  } catch { /* non-fatal */ }
}

/**
 * Load a pending wine for editing. A wine that exists but is NOT pending is a
 * 409, not a 404: the id is real and the curator should know their fix landed
 * (or someone else's did) rather than hunt a "missing" row. A non-existent id
 * is a 404.
 */
async function loadPendingWine(wineId) {
  if (!mongoose.isValidObjectId(String(wineId))) {
    return { ok: false, code: 'invalid_input', message: 'Invalid wine id' };
  }
  const wine = await WineDefinition.findById(wineId);
  if (!wine) return { ok: false, code: 'not_found', message: 'No wine with that id' };
  if (wine.pendingIdentity !== true) {
    return {
      ok: false,
      code: 'conflict',
      message: 'That wine is not in the pending-identity queue — it has already been completed. Use the normal correction path.',
    };
  }
  return { ok: true, wine };
}

module.exports = {
  queryPendingWines,
  validatePendingFix,
  applyPendingFix,
  loadPendingWine,
  runPromotionFollowThrough,
  FIXABLE_FIELDS,
  CROSS_FIELD_OVERRIDE_FIELD,
  CREATED_VIA_FILTERS,
  FIELD_MAX,
  MAX_BOTTLE_IMAGES,
};
