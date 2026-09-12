/**
 * wineDraftOps — everything a creator can do with a PRIVATE DRAFT wine, in
 * one place for the REST router (routes/wineDrafts.js) and the MCP tools.
 * Support ticket 2026-09-12; the design note lives on
 * models/WineDefinition.draft.
 *
 * A draft is a pendingIdentity row (invariant) with `draft: true`, keyed into
 * the per-creator 'draft~' namespace. Its creator edits it directly (no
 * correction queue — nothing is shared yet), and PUBLISHES it as an explicit
 * step: the mint gates the draft skipped run then, the duplicate check runs
 * against the ordinary registry, and on success the row leaves the draft
 * namespace and the model hook promotes it exactly as a curator-completed
 * pending row is promoted (services/pendingWineOps.runPromotionFollowThrough
 * is reused, so search / bottle index / embeddings / enrichment / maturity
 * seeding / IndexNow all happen once, here).
 *
 * Results are transport-neutral: { ok: true, ... } or { ok: false, code,
 * message } — codes: invalid_input | not_found | conflict | duplicate |
 * similar | invalid_identity.
 */

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const WineVintageProfile = require('../models/WineVintageProfile');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const { logAudit } = require('./audit');
const {
  generateWineKey, pendingWineKey, draftWineKey, normalizeAppellation, normalizeAppellationKey,
  normalizeString, resolveCountryName, isIdentitySentinel, isImplausibleIdentity, stripTrailingVintage,
} = require('../utils/normalize');
const { canonicalizeWineName } = require('../utils/producerPrefix');
const { resolveCanonicalAppellation } = require('./appellationResolve');
const { resolveGrapeIdsStrict } = require('./wineProfileOps');
const { validatePendingFix, runPromotionFollowThrough } = require('./pendingWineOps');
const { findVisibleWine } = require('./wineVisibility');
const { isValidId } = require('../utils/validation');

const DRAFT_TTL_DAYS = 7;
const DRAFT_TTL_MS = DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;
const DRAFT_WARN_HOURS = 24;
const PUBLISH_BATCH_MAX = 24;
const FIELD_MAX = 200;
// What a creator may edit on their draft. The same names the curation queue's
// fix takes (validatePendingFix), plus classification (display data a draft
// commonly carries from a scan).
const DRAFT_FIELDS = ['name', 'producer', 'appellation', 'regionName', 'countryName', 'grapeNames', 'type', 'classification'];

const fail = (code, message) => ({ ok: false, code, message });
const POPULATE = [
  { path: 'country', select: 'name' },
  { path: 'region', select: 'name' },
  { path: 'grapes', select: 'name' },
];

/** The draft as the creator sees it — never createdBy, never the dedup keys. */
function draftSummary(w, extra = {}) {
  const name = (x) => (x && typeof x === 'object' ? x.name : null);
  return {
    _id: w._id,
    name: w.name,
    producer: w.producer || '',
    appellation: w.appellation || null,
    classification: w.classification || null,
    type: w.type || null,
    country: name(w.country),
    region: name(w.region),
    grapes: Array.isArray(w.grapes) ? w.grapes.map((g) => name(g)).filter(Boolean) : [],
    draft: true,
    draftExpiresAt: w.draftExpiresAt || null,
    createdAt: w.createdAt,
    ...extra,
  };
}

/** A registry match the publish step offers as "attach instead". */
function matchSummary(w, score) {
  const name = (x) => (x && typeof x === 'object' ? x.name : null);
  return {
    wine_id: String(w._id),
    name: w.name,
    producer: w.producer || null,
    appellation: w.appellation || null,
    country: name(w.country),
    region: name(w.region),
    type: w.type || null,
    ...(score != null ? { score } : {}),
  };
}

/**
 * Shape validation for a draft edit. Delegates the shared fields to the
 * curation queue's validator so the two never drift, with two draft-only
 * differences: the producer MAY be emptied (a draft can be producerless —
 * that queue exists to fill the field, this one does not), and
 * classification is editable.
 */
function validateDraftPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'A patch object is required' };
  }
  // Curation-only knobs never apply to a draft.
  const { identityUnavailable, crossFieldOverride, classification, ...rest } = patch; // eslint-disable-line no-unused-vars
  const producerCleared = typeof rest.producer === 'string' && rest.producer.trim() === '';
  if (producerCleared) delete rest.producer;
  let clean = {};
  if (Object.keys(rest).length > 0) {
    const v = validatePendingFix(rest);
    if (!v.ok) return v;
    clean = { ...v.clean };
  }
  if (producerCleared) clean.producer = '';
  if (classification !== undefined) {
    if (classification !== null && typeof classification !== 'string') {
      return { ok: false, error: 'classification must be a string' };
    }
    const c = (classification || '').trim().replace(/\s+/g, ' ');
    if (c.length > FIELD_MAX) return { ok: false, error: `classification must be at most ${FIELD_MAX} characters` };
    clean.classification = c;
  }
  if (Object.keys(clean).length === 0) {
    return { ok: false, error: `Nothing to change — send at least one of: ${DRAFT_FIELDS.join(', ')}` };
  }
  return { ok: true, clean };
}

/** The creator's own draft, as a saveable document — or not_found. */
async function loadOwnDraft(wineId, userId) {
  if (!isValidId(String(wineId))) return fail('invalid_input', 'Invalid wine id');
  const wine = await WineDefinition.findOne({ _id: String(wineId), draft: true, createdBy: userId });
  if (!wine) return fail('not_found', 'No draft with that id.');
  return { ok: true, wine };
}

/** Every draft this user holds, oldest clock first, with bottle counts. */
async function listDrafts(userId) {
  const rows = await WineDefinition.find({ createdBy: userId, draft: true })
    .sort({ draftExpiresAt: 1 })
    .populate(POPULATE)
    .lean();
  const ids = rows.map((r) => r._id);
  const counts = new Map();
  if (ids.length) {
    const agg = await Bottle.aggregate([
      { $match: { wineDefinition: { $in: ids } } },
      { $group: { _id: '$wineDefinition', n: { $sum: 1 } } },
    ]);
    for (const a of agg) counts.set(String(a._id), a.n);
  }
  return { ok: true, drafts: rows.map((r) => draftSummary(r, { bottleCount: counts.get(String(r._id)) || 0 })) };
}

/**
 * Restart the untouched clock. Called on every edit, every bottle add
 * (services/bottleOps) and every scan attach. Filtered on draft:true so a row
 * published in between is never given a clock back.
 */
async function touchDraft(wineId) {
  await WineDefinition.updateOne(
    { _id: wineId, draft: true },
    { $set: { draftExpiresAt: new Date(Date.now() + DRAFT_TTL_MS), draftExpiryWarnedAt: null } }
  );
}

/**
 * Apply a validated patch to the creator's draft. The taxonomy half of the
 * curation queue's applyPendingFix, verbatim in semantics — appellation
 * canonicalised, country resolved never minted, region through the gated
 * helper, grapes match-only — WITHOUT the identity gates: the row is private,
 * and publish runs them. The key stays in the draft namespace.
 */
async function updateDraft(wine, clean, userId) {
  const snap = (w) => ({
    name: w.name, producer: w.producer || '', appellation: w.appellation || null,
    classification: w.classification || null, type: w.type || null,
  });
  const before = snap(wine);

  if (clean.name) wine.name = clean.name;
  if (clean.producer !== undefined) wine.producer = clean.producer;
  if (clean.appellation !== undefined) {
    wine.appellation = clean.appellation
      ? await resolveCanonicalAppellation(normalizeAppellation(clean.appellation))
      : null;
  }
  if (clean.type) wine.type = clean.type;
  if (clean.classification !== undefined) wine.classification = clean.classification || null;

  let countryDoc = null;
  if (clean.countryName !== undefined) {
    // Country is required on every registry row — it cannot be cleared, and
    // saying so beats a silent no-op the form springs back from (audit 2026-09-12).
    if (!clean.countryName) return fail('invalid_input', 'Country cannot be cleared — every wine needs one.');
    countryDoc = await Country.findOne({ normalizedName: normalizeString(resolveCountryName(clean.countryName)) });
    if (!countryDoc) {
      return fail('invalid_input', `Unknown country "${clean.countryName}" — pick one the registry already knows.`);
    }
    wine.country = countryDoc._id;
  }
  if (clean.regionName !== undefined) {
    if (!clean.regionName) {
      wine.region = null;
    } else {
      // Lazy require: findOrCreateWine top-requires services/search (ESM-only
      // meilisearch client) — same reason pendingWineOps requires it lazily.
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
        return fail('invalid_input',
          `Not in the grape taxonomy: ${resolved.unmatched.join(', ')}. Synonyms resolve ("Shiraz" finds Syrah).`);
      }
      wine.grapes = resolved.ids;
      grapeNames = resolved.names;
    }
  }

  if (clean.name || clean.producer !== undefined || clean.appellation !== undefined) {
    // The stored name follows the resolver's own shaping (trailing vintage
    // stripped, producer prefix folded out — services/findOrCreateWine does
    // exactly this before keying a mint), so a retry add of the same wine
    // resolves to this draft instead of minting a second one, and the key the
    // publish step regenerates matches what the registry would compute
    // (audit 2026-09-12).
    wine.name = canonicalizeWineName(stripTrailingVintage(wine.name), wine.producer || '') || wine.name;
    wine.normalizedKey = draftWineKey(wine.name, wine.producer, wine.createdBy, wine.appellation);
  }
  wine.draftExpiresAt = new Date(Date.now() + DRAFT_TTL_MS);
  wine.draftExpiryWarnedAt = null;

  try {
    await wine.save();
  } catch (err) {
    if (err?.code === 11000) {
      return fail('conflict', 'You already have a draft of exactly this wine — edit that one instead.');
    }
    if (err?.name === 'VersionError') return fail('conflict', 'The draft changed mid-write — retry.');
    throw err;
  }

  const after = snap(wine);
  const diff = {};
  for (const k of Object.keys(after)) if (before[k] !== after[k]) diff[k] = { from: before[k], to: after[k] };
  if (clean.countryName !== undefined) diff.country = { to: clean.countryName || null };
  if (clean.regionName !== undefined) diff.region = { to: clean.regionName || null };
  if (grapeNames !== null) diff.grapes = { to: grapeNames };
  return { ok: true, wine, diff };
}

/**
 * The mint gates findOrCreateWine skipped for the draft, run at publish
 * (same rules, same messages as the curation surfaces). A MISSING producer
 * is not a refusal: the draft publishes as an ordinary pending row for a
 * curator to finish, exactly like an add with no producer does today.
 */
async function checkPublishIdentity(wine) {
  const name = (wine.name || '').trim();
  if (!name) return { ok: false, message: 'The draft needs a wine name before it can be published.' };
  const producer = (wine.producer || '').trim();
  if (!producer || isIdentitySentinel(producer)) return { ok: true, producerMissing: true };
  const producerNorm = normalizeString(producer);
  if (producerNorm.length < 2) return { ok: false, message: `"${producer}" is not a usable producer name` };
  const [placeCountry, placeRegion, placeAppellation] = await Promise.all([
    Country.exists({ normalizedName: producerNorm }),
    Region.exists({ $or: [{ normalizedName: producerNorm }, { normalizedSynonyms: producerNorm }] }),
    Appellation.exists({ normalizedName: { $in: [producerNorm, normalizeAppellationKey(producer)] } }),
  ]);
  if (placeCountry || placeRegion || placeAppellation) {
    return { ok: false, message: `"${producer}" is a wine region, not a producer — put the actual winery in the producer field` };
  }
  if (isImplausibleIdentity(producer, name)) {
    return { ok: false, message: `"${producer}" is not a usable producer name — it is only house words (Domaine, Casa, Estate) with no winery attached to them` };
  }
  const { detectBlockingProducerIssue } = require('./crossFieldScan');
  const blocking = await detectBlockingProducerIssue({ name, producer, appellation: wine.appellation });
  if (blocking) {
    return {
      ok: false,
      message: `"${producer}" is not a usable producer name — cross-field rule ${blocking.check} matched "${blocking.detail}", which belongs in a different field`,
    };
  }
  return { ok: true, producerMissing: false };
}

/** The draft's identity as findOrCreateWine takes it (names, not ids). */
async function identityForResolve(wine) {
  const [country, region, grapes] = await Promise.all([
    wine.country ? Country.findById(wine.country).select('name').lean() : null,
    wine.region ? Region.findById(wine.region).select('name').lean() : null,
    Array.isArray(wine.grapes) && wine.grapes.length ? Grape.find({ _id: { $in: wine.grapes } }).select('name').lean() : [],
  ]);
  return {
    name: wine.name,
    producer: wine.producer || '',
    country: country?.name || '',
    region: region?.name || '',
    appellation: wine.appellation || '',
    type: wine.type,
    grapes: (grapes || []).map((g) => g.name),
    classification: wine.classification || undefined,
  };
}

/**
 * PUBLISH: the draft enters the shared registry as it stands.
 *
 *   1. identity gates (checkPublishIdentity) — interactive: refused with the
 *      curation-surface message; auto (the expiry job): published as a
 *      pending row instead, the auto path must never fail.
 *   2. duplicate check against the ordinary registry (findOrCreateWine in
 *      matchOnly mode, the draft's own id excluded) — a confident match is
 *      `duplicate` with the match (attach instead); soft-zone candidates are
 *      `similar` unless confirmCreate (auto: publish anyway, recorded as a
 *      near miss, mirroring the import path).
 *   3. the key leaves the draft namespace (ordinary key when the hook will
 *      promote, the per-creator pending key otherwise), `draft` clears, save
 *      — the model hook promotes; E11000 here is a duplicate found by the
 *      unique index, answered the same way as step 2.
 *   4. promoted → the one promotion follow-through, once.
 */
async function publishDraft(wine, { userId = null, req = null, confirmCreate = false, auto = false, reason = null } = {}) {
  if (wine.draft !== true) return fail('conflict', 'This wine is not a draft.');

  const identity = await checkPublishIdentity(wine);
  let producerMissing = identity.ok ? identity.producerMissing === true : false;
  // The producer string an unattended publish had to drop survives in the
  // audit entry, as it does for a refused mint (audit 2026-09-12).
  let rejectedProducer = null;
  if (!identity.ok) {
    if (!auto) return fail('invalid_identity', identity.message);
    rejectedProducer = { producer: wine.producer, reason: identity.message };
    producerMissing = true;
  }

  const { findOrCreateWine } = require('./findOrCreateWine');
  const ident = await identityForResolve(wine);
  const resolved = await findOrCreateWine(
    { ...ident, producer: producerMissing ? '' : ident.producer },
    String(wine.createdBy),
    { matchOnly: true, allowPending: true, excludeId: wine._id, confirmCreate: !!confirmCreate, skipSiblingMatch: !!confirmCreate }
  );
  let nearMiss = null;
  if (resolved.wine) {
    return { ok: false, code: 'duplicate', message: 'The registry already holds this wine — attach your bottles to it instead.', match: matchSummary(resolved.wine) };
  }
  if (resolved.candidates && resolved.candidates.length) {
    if (!auto && !confirmCreate) {
      return {
        ok: false, code: 'similar',
        message: 'The registry holds wines that look like this one — pick one to attach your bottles to, or confirm this is a new wine.',
        candidates: resolved.candidates.map((c) => matchSummary(c.wine, c.score)),
      };
    }
    nearMiss = resolved.candidates.map((c) => ({ wine_id: String(c.wine._id), score: c.score }));
  }

  // Everything below mutates the document before the save; a failed save
  // must hand the caller back the draft it passed in (the expiry job and the
  // erasure path reuse the object for the attach that follows a duplicate —
  // audit 2026-09-12).
  const before = {
    producer: wine.producer, normalizedKey: wine.normalizedKey, draft: wine.draft,
    draftExpiresAt: wine.draftExpiresAt, draftExpiryWarnedAt: wine.draftExpiryWarnedAt,
  };
  if (producerMissing) wine.producer = '';
  const willPromote = !producerMissing &&
    !isIdentitySentinel(wine.producer) && !isIdentitySentinel(wine.name) &&
    !isImplausibleIdentity(wine.producer, wine.name);
  const publishedKey = willPromote
    ? generateWineKey(wine.name, wine.producer, wine.appellation)
    : pendingWineKey(wine.name, wine.createdBy, wine.appellation);
  wine.normalizedKey = publishedKey;
  wine.draft = false;
  wine.draftExpiresAt = null;
  wine.draftExpiryWarnedAt = null;

  try {
    await wine.save();
  } catch (err) {
    // Whatever failed, the in-memory document is a draft again.
    Object.assign(wine, before);
    if (err?.code === 11000) {
      const holder = await WineDefinition.findOne({ normalizedKey: publishedKey, _id: { $ne: wine._id } })
        .populate(POPULATE).lean();
      return {
        ok: false, code: 'duplicate',
        message: 'The registry already holds this wine — attach your bottles to it instead.',
        ...(holder ? { match: matchSummary(holder) } : {}),
      };
    }
    throw err;
  }

  const promoted = wine.pendingIdentity !== true;
  if (promoted) await runPromotionFollowThrough(wine);

  // Actor: the request user, or `system` for the jobs — never the creator's
  // id in the detail (erasure could not scrub it there).
  logAudit(req || null, auto ? 'wine.draft_auto_publish' : 'wine.draft_publish',
    { type: 'wine', id: wine._id },
    {
      name: wine.name, producer: wine.producer || null, promoted, pendingCuration: !promoted,
      ...(reason ? { reason } : {}),
      ...(nearMiss ? { nearMiss } : {}),
      ...(rejectedProducer ? { rejectedProducer: rejectedProducer.producer, rejectedBecause: rejectedProducer.reason } : {}),
    });
  return { ok: true, wine, promoted, pendingCuration: !promoted };
}

/** Batch publish: per-id results, one failure never stops the rest. */
async function publishDrafts(ids, userId, { req = null, confirmCreate = false } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return fail('invalid_input', 'ids must be a non-empty array');
  if (ids.length > PUBLISH_BATCH_MAX) return fail('invalid_input', `At most ${PUBLISH_BATCH_MAX} drafts per call`);
  const results = [];
  for (const id of ids) {
    const loaded = await loadOwnDraft(id, userId);
    if (!loaded.ok) { results.push({ id: String(id), status: loaded.code, error: loaded.message }); continue; }
    try {
      const r = await publishDraft(loaded.wine, { userId, req, confirmCreate });
      if (r.ok) results.push({ id: String(id), status: r.promoted ? 'published' : 'pending_curation' });
      else results.push({ id: String(id), status: r.code, error: r.message, ...(r.match ? { match: r.match } : {}), ...(r.candidates ? { candidates: r.candidates } : {}) });
    } catch (err) {
      results.push({ id: String(id), status: 'error', error: 'Publish failed — retry.' });
      console.error('[wineDraftOps] publishDrafts item failed:', err.message);
    }
  }
  return { ok: true, results };
}

/**
 * Remove the draft row and what only it owns. Bottles (if any) must already
 * have been re-pointed by the caller. Same cleanup as the undo GC
 * (services/registryGc), minus the guards that protect curated registry
 * data — a draft has none.
 */
async function removeDraftRow(wine, req, action, detail = {}, { requireEmpty = false } = {}) {
  await WineVintageProfile.deleteMany({ wineDefinition: wine._id, status: 'pending' });
  await deleteDraftImages(wine._id);
  try { require('./search').removeWine(wine._id); } catch { /* never indexed; best-effort */ }
  // The "no bottles" decision is repeated right before the delete: a bottle
  // added during the cleanup above must not be left pointing at nothing
  // (audit 2026-09-12). The predicate on draft:true guards a publish in the
  // same window the same way.
  if (requireEmpty && await Bottle.exists({ wineDefinition: wine._id })) {
    return { ok: false, code: 'conflict', message: 'A bottle was added to this draft while it was being removed — it stays.' };
  }
  const del = await WineDefinition.deleteOne({ _id: wine._id, draft: true });
  if (!del?.deletedCount) {
    return { ok: false, code: 'conflict', message: 'This draft changed while it was being removed — it stays.' };
  }
  logAudit(req || null, action, { type: 'wine', id: wine._id },
    { name: wine.name, producer: wine.producer || null, ...detail });
  return { ok: true };
}

/** Unlink and delete every image row on the draft (or only the label-scan frames). */
async function deleteDraftImages(wineId, filter = {}) {
  const images = await BottleImage.find({ wineDefinition: wineId, ...filter });
  if (!images.length) return;
  const { unlinkImageFiles } = require('./imageProcessor');
  for (const img of images) {
    try { await unlinkImageFiles(img); } catch { /* file may already be gone */ }
  }
  await BottleImage.deleteMany({ _id: { $in: images.map((i) => i._id) } });
}

/**
 * ATTACH INSTEAD: the publish step found the wine already in the registry —
 * move the draft's bottles (and their photos) onto that wine and dissolve
 * the draft. Co-members' bottles move too: the draft is being dissolved, and
 * a bottle pointing at a deleted wine is the worse outcome.
 */
async function attachDraftBottles(wine, targetWineId, { userId, roles = [], req = null, auto = false, reason = null } = {}) {
  if (wine.draft !== true) return fail('conflict', 'This wine is not a draft.');
  const target = await findVisibleWine(String(targetWineId), { userId, roles, noDrafts: true, populate: POPULATE });
  if (!target) return fail('not_found', 'No registry wine with that id.');
  if (String(target._id) === String(wine._id)) return fail('invalid_input', 'A draft cannot be attached to itself.');

  const bottleIds = await Bottle.distinct('_id', { wineDefinition: wine._id });
  // Only the vintages still in a cellar get a maturity row on the target
  // (the promotion follow-through uses the same status filter).
  const vintages = await Bottle.distinct('vintage', { wineDefinition: wine._id, status: 'active' });
  // The label-scan frames stay with the draft and go with it: they are
  // curation evidence for a row that is not becoming registry content, and
  // on the target they would be unreadable-but-retained forever.
  await deleteDraftImages(wine._id, { kind: 'label-scan' });
  // Then EVERY reference follows the bottles — the admin merge's own
  // re-pointer (audit 2026-09-12): bottles, their photos, price-tracking
  // requests and skips, wishlist items, reviews, reports, discussions, journal
  // pairings, recommendations, restock alerts, wine-list entries. A draft's
  // bottle can acquire any of these exactly like an ordinary one, and a
  // two-collection re-point left the rest pointing at a deleted id.
  // Lazy: the admin router is a heavy module tree.
  const { reassignWineRefs } = require('../routes/admin/wines');
  await reassignWineRefs(wine._id, target._id);
  try {
    const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
    for (const v of vintages) if (v) await ensurePendingVintageProfile(target._id, v);
  } catch (err) {
    console.warn('[wineDraftOps] maturity seed after attach failed (non-fatal):', err.message);
  }
  await removeDraftRow(wine, req, auto ? 'wine.draft_auto_attach' : 'wine.draft_attach',
    { targetId: target._id, target: `${target.producer || '?'} — ${target.name}`, bottlesMoved: bottleIds.length, ...(reason ? { reason } : {}) });
  if (bottleIds.length) {
    try {
      const p = require('./search').bulkIndexBottles(bottleIds);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* best-effort */ }
  }
  return { ok: true, wine: target, bottlesMoved: bottleIds.length };
}

/** Delete an EMPTY draft. A draft holding bottles is attached or published, never deleted. */
async function deleteDraft(wine, req = null, { action = 'wine.draft_delete' } = {}) {
  if (wine.draft !== true) return fail('conflict', 'This wine is not a draft.');
  if (await Bottle.exists({ wineDefinition: wine._id })) {
    return fail('conflict', 'This draft holds bottles — publish it, or attach the bottles to an existing wine, instead of deleting it.');
  }
  return removeDraftRow(wine, req, action, {}, { requireEmpty: true });
}

module.exports = {
  DRAFT_TTL_DAYS,
  DRAFT_TTL_MS,
  DRAFT_WARN_HOURS,
  DRAFT_FIELDS,
  PUBLISH_BATCH_MAX,
  draftSummary,
  matchSummary,
  validateDraftPatch,
  loadOwnDraft,
  listDrafts,
  touchDraft,
  updateDraft,
  checkPublishIdentity,
  publishDraft,
  publishDrafts,
  attachDraftBottles,
  deleteDraft,
};
