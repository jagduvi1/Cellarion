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
const { generateWineKey, normalizeAppellation, normalizeString, resolveCountryName } = require('../utils/normalize');
const { resolveGrapeIdsStrict, GRAPES_MAX, GRAPE_NAME_MAX, WINE_TYPES } = require('./wineProfileOps');

// Fields a curator may set. `producer` and `name` are the two that promote the
// row; the rest ride along so one pass can fix everything the misread label
// got wrong. Deliberately NOT here: type-only/profile fields (set_wine_profile
// owns those), nonWine (a quarantine proposal), and anything about the bottle.
const FIXABLE_FIELDS = ['producer', 'name', 'appellation', 'regionName', 'countryName', 'grapeNames', 'type'];
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
 * @param {string} [opts.createdVia] one of CREATED_VIA_FILTERS — the filter
 *   that makes a big import burst workable: 500 rows from one CSV are one
 *   `createdVia:'import'` sweep, and a curator can leave them for a batch
 *   session while still clearing the trickle of 'ui' scans. (Grouping by
 *   import session was the alternative; ImportSession is deleted the moment an
 *   import finishes, so there would be nothing left to group by.)
 * @returns {{ rows, total, pendingTotal }}
 */
async function queryPendingWines({ limit = 20, offset = 0, createdVia = null } = {}) {
  const filter = { pendingIdentity: true };
  // Literal from the static array, never raw input (CodeQL query-injection
  // rule, the aiBudgetRequests pattern).
  const viaIdx = CREATED_VIA_FILTERS.indexOf(String(createdVia || ''));
  if (viaIdx !== -1) filter.createdVia = CREATED_VIA_FILTERS[viaIdx];

  const [wines, total, pendingTotal] = await Promise.all([
    WineDefinition.find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name')
      .lean(),
    WineDefinition.countDocuments(filter),
    WineDefinition.countDocuments({ pendingIdentity: true }),
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

  return { rows, total, pendingTotal };
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
  };

  if (clean.name) wine.name = clean.name;
  if (clean.producer) wine.producer = clean.producer;
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

  // Same rule as the admin PUT and the proposal approve: the dedup key follows
  // name/producer/appellation. Regenerating it here is also what moves a
  // promoted row OUT of the pending key namespace (pending~<creator>:…) and
  // into the ordinary one, where the unique index re-checks it.
  if (clean.name || clean.producer || clean.appellation !== undefined) {
    wine.normalizedKey = generateWineKey(wine.name, wine.producer, wine.appellation);
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
  };
  const diff = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) diff[k] = { from: before[k], to: after[k] };
  }
  if (clean.countryName !== undefined) diff.country = { to: clean.countryName || null };
  if (clean.regionName !== undefined) diff.region = { to: clean.regionName || null };
  if (grapeNames !== null) diff.grapes = { to: grapeNames };

  return { ok: true, wine, promoted, diff, grapeNames };
}

/**
 * Everything a wine was excluded from while pending, let back in — exactly
 * once, right here, so no caller has to remember the list.
 *
 * All best-effort: the fix itself is committed, and none of these may fail it.
 */
async function runPromotionFollowThrough(wine) {
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
  CREATED_VIA_FILTERS,
  FIELD_MAX,
  MAX_BOTTLE_IMAGES,
};
