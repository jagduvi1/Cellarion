// Shared bottle mutations — ONE implementation for the REST routes and the MCP
// tools (plan §7), so validation, rack-slot freeing, re-indexing, audit and
// SSE nudges can never drift between the two surfaces.
//
// Contract: each op takes a LOADED, ACCESS-CHECKED bottle document (the caller
// owns authorization — requireBottleAccess on REST, resolveBottleAccess on
// MCP) plus a req-like object for audit attribution ({ user, headers, ip … };
// the real req on both surfaces). Returns { error: { status, message, code? } }
// for client faults, or the mutated { bottle } on success.
//
// services/search and services/restockChecker are required LAZILY inside the
// functions: search top-requires the ESM-only meilisearch package, which jest
// cannot parse — a top-level require here would break every suite that loads
// the MCP tool registry (the #702 failure mode).
const { CONSUMED_STATUSES } = require('../config/constants');
const { resolveRating } = require('../utils/ratingUtils');
const resolveRatingUtil = resolveRating;
const { stripHtml, isSafeUrl } = require('../utils/sanitize');
const { parseAndValidateVintage, parseDrinkYear } = require('../utils/validation');
const { normalizeBottleSize, DEFAULT_SIZE } = require('../config/bottleSizes');
const { logAudit } = require('./audit');
const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');

// Restores are "undo an accidental log", not resurrection of a bottle drunk
// long ago (see the /restore route docs). Shared so REST and MCP agree.
const RESTORE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

/** Free any rack slot holding this bottle (consume/delete paths). */
async function removeFromRacks(bottleId) {
  await Rack.updateMany(
    { 'slots.bottle': bottleId },
    // $inc __v: this $pull bypasses document save(), so without the version
    // bump a concurrent whole-slots writer (auto_arrange apply/undo, which
    // compares occupancy then save()s) would pass its optimistic-concurrency
    // check and resurrect the just-removed bottle into a slot. Bumping the
    // version turns that race into a clean VersionError → conflict.
    { $pull: { slots: { bottle: bottleId } }, $inc: { __v: 1 } }
  );
}

/**
 * Mark a bottle consumed (drank/gifted/sold/other), free its rack slot,
 * re-index, audit (which also emits the stats_changed SSE nudge), and fire the
 * restock-gap check. Mirrors POST /api/bottles/:id/consume exactly.
 */
async function consumeBottle(bottle, { reason = 'drank', note, rating, ratingScale } = {}, req) {
  if (!CONSUMED_STATUSES.includes(reason)) {
    return { error: { status: 400, message: 'Invalid reason' } };
  }
  if (note && (typeof note !== 'string' || note.length > 1000)) {
    return { error: { status: 400, message: 'Note is too long (max 1000 characters)' } };
  }
  const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } =
    resolveRating(rating, ratingScale);
  if (ratingError) return { error: { status: 400, message: ratingError } };

  bottle.status = reason;
  bottle.consumedAt = new Date();
  bottle.consumedReason = reason;
  if (note) bottle.consumedNote = stripHtml(note);
  if (resolvedRating !== undefined) {
    bottle.consumedRating = resolvedRating;
    bottle.consumedRatingScale = resolvedScale;
  }

  await bottle.save();

  // Free the rack slot AFTER the save, so a failed save doesn't leave an
  // active bottle already pulled from its rack.
  await removeFromRacks(bottle._id);

  // Consumed bottles stay in the index for history search (filtered at query
  // time) — re-index so status is current. Fire-and-forget.
  require('./search').indexBottle(bottle._id);

  logAudit(req, 'bottle.consume',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { reason }
  );

  // Fire-and-forget restock-gap check. Skipped for demo accounts: on an
  // un-cached (wine, vintage) pair this fires a paid Voyage embedding call,
  // which would breach the demo's "zero AI spend" guarantee.
  if (reason === 'drank' && !req?.user?.isDemo) {
    const { checkRestockGap } = require('./restockChecker');
    checkRestockGap(req.user.id, bottle._id, bottle.cellar).catch(() => {});
  }

  return { bottle };
}

/**
 * Put a recently-consumed bottle back to active — the inverse of consume.
 * Clears every consumed-* field; the bottle deliberately comes back UNPLACED
 * (its old slot was freed and may be occupied). Only within RESTORE_WINDOW_MS.
 * Mirrors POST /api/bottles/:id/restore exactly.
 */
async function restoreBottle(bottle, req) {
  if (bottle.status === 'active') {
    return { error: { status: 400, message: 'Bottle is already active' } };
  }
  if (!CONSUMED_STATUSES.includes(bottle.status)) {
    return { error: { status: 400, message: 'Only a consumed bottle can be restored' } };
  }
  if (bottle.consumedAt && (Date.now() - new Date(bottle.consumedAt).getTime()) > RESTORE_WINDOW_MS) {
    return {
      error: {
        status: 400,
        message: 'This bottle was removed too long ago to move back. Add it again as a new bottle instead.',
        code: 'restore_window_expired',
      },
    };
  }

  const previousStatus = bottle.status;
  bottle.status = 'active';
  bottle.consumedAt = undefined;
  bottle.consumedReason = undefined;
  bottle.consumedNote = undefined;
  bottle.consumedRating = undefined;
  bottle.consumedRatingScale = undefined;
  await bottle.save();

  require('./search').indexBottle(bottle._id);

  logAudit(req, 'bottle.restore',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { from: previousStatus }
  );

  return { bottle, from: previousStatus };
}

/**
 * Create a bottle in an ACCESS-CHECKED cellar for an EXISTING registry wine —
 * the shared core of REST POST /api/bottles and the MCP add_bottle tool.
 * Mirrors the route's field handling exactly (validation helpers, caps,
 * priceSetAt anchoring, owner = cellar owner) and fires the same post-save
 * side effects, so the two surfaces cannot drift. The enrichment/embedding
 * calls inherit their internal kill-switch + per-user budget gates.
 *
 * Returns { error: { status, message } } | { bottle }.
 */
async function addBottle(cellarDoc, wineDoc, fields = {}, req) {
  const {
    vintage, price, currency, bottleSize,
    purchaseDate, purchaseLocation, purchaseUrl,
    notes, occasion, rating, ratingScale, drinkFrom, drinkTo,
  } = fields;

  const parsedVintage = parseAndValidateVintage(vintage);
  if (!parsedVintage.ok) return { error: { status: 400, message: parsedVintage.error } };

  const from = parseDrinkYear(drinkFrom, 'drinkFrom');
  if (!from.ok) return { error: { status: 400, message: from.error } };
  const to = parseDrinkYear(drinkTo, 'drinkTo');
  if (!to.ok) return { error: { status: 400, message: to.error } };
  if (from.value && to.value && from.value > to.value) {
    return { error: { status: 400, message: 'drinkFrom cannot be after drinkTo' } };
  }

  const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } =
    resolveRatingUtil(rating, ratingScale);
  if (ratingError) return { error: { status: 400, message: ratingError } };

  if (notes && (typeof notes !== 'string' || notes.length > 5000)) {
    return { error: { status: 400, message: 'Notes are too long (max 5000 characters)' } };
  }
  const capped = [['occasion', occasion], ['purchaseLocation', purchaseLocation]];
  for (const pair of capped) {
    if (pair[1] && (typeof pair[1] !== 'string' || pair[1].length > 500)) {
      return { error: { status: 400, message: pair[0] + ' is too long (max 500 characters)' } };
    }
  }
  if (purchaseUrl && (typeof purchaseUrl !== 'string' || purchaseUrl.length > 2048 || !isSafeUrl(purchaseUrl))) {
    return { error: { status: 400, message: 'purchaseUrl is not a valid http(s) URL' } };
  }

  const hasPrice = price !== undefined && price !== null && price !== '';
  const doc = {
    user: cellarDoc.user, // bottle owner = cellar owner, same as the REST route
    cellar: cellarDoc._id,
    wineDefinition: wineDoc._id,
    vintage: parsedVintage.value,
    bottleSize: normalizeBottleSize(bottleSize) || DEFAULT_SIZE,
    purchaseDate: purchaseDate || new Date(), // REST defaults this too
  };
  if (hasPrice) {
    doc.price = price;
    doc.currency = currency || 'USD';
    doc.priceSetAt = new Date();
  }
  if (purchaseLocation) doc.purchaseLocation = stripHtml(purchaseLocation);
  if (purchaseUrl) doc.purchaseUrl = purchaseUrl;
  if (notes) doc.notes = stripHtml(notes);
  if (occasion) doc.occasion = stripHtml(occasion);
  if (resolvedRating !== undefined) {
    doc.rating = resolvedRating;
    doc.ratingScale = resolvedScale;
  }
  if (from.value !== undefined) doc.drinkFrom = from.value;
  if (to.value !== undefined) doc.drinkTo = to.value;

  const bottle = new Bottle(doc);
  // Seed the cellar journey exactly like the REST route: the bottle enters
  // this cellar at its added date.
  bottle.addedToCellarAt = bottle.createdAt;
  bottle.cellarHistory = [{ cellar: cellarDoc._id, cellarName: cellarDoc.name, enteredAt: bottle.createdAt }];
  try {
    await bottle.save();
  } catch (err) {
    if (err?.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    throw err;
  }

  // Same post-save side effects as the REST route, same order.
  require('./search').indexBottle(bottle._id);
  try {
    const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
    await ensurePendingVintageProfile(wineDoc._id, bottle.vintage);
  } catch (err) { /* profile bookkeeping must never fail the add */ }
  // Include wineName so the Cellar Audit page shows what was added, matching
  // the REST POST /bottles audit (grand-audit M5 — AI-added bottles showed a
  // bare vintage with no wine name). wineDoc is the resolved registry wine.
  logAudit(req, 'bottle.add',
    { type: 'bottle', id: bottle._id, cellarId: cellarDoc._id },
    { wineName: wineDoc.name, vintage: bottle.vintage });
  if (hasPrice) {
    require('../utils/exchangeRates').getOrCreateDailySnapshot().catch(() => {});
  }
  // Fire-and-forget AI enrichment — both calls carry their own kill-switch /
  // per-user budget gates (embeddingJob: chatEnabled; enrichmentJob: tryDebitAi).
  const { embedSinglePair } = require('./embeddingJob');
  embedSinglePair(wineDoc._id, bottle.vintage).catch(() => {});
  const { enrichWineById } = require('./enrichmentJob');
  enrichWineById(wineDoc._id, { budgetUserId: req && req.user ? req.user.id : undefined }).catch(() => {});
  const { resolveRestockAlerts } = require('./restockChecker');
  resolveRestockAlerts(req?.user?.id || cellarDoc.user, wineDoc._id, bottle._id).catch(() => {});

  return { bottle };
}

// Fields update_bottle may touch — the AI-useful subset of the REST PUT route.
const UPDATABLE_FIELDS = ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'];

/**
 * Diff-based partial update of an access-checked bottle (MCP update_bottle).
 * Mirrors the REST PUT route's handling for the fields it covers: rating
 * resolution against the bottle's own scale, drink-window ordering +
 * notifier-marker reset, priceSetAt re-anchoring, HTML stripping, re-index,
 * bottle.update audit. Returns { error } | { bottle, changes, prev }.
 */
async function updateBottleFields(bottle, fields, req) {
  fields = fields || {};
  const changes = {};
  const prev = {};

  if (fields.notes !== undefined && fields.notes &&
      (typeof fields.notes !== 'string' || fields.notes.length > 5000)) {
    return { error: { status: 400, message: 'Notes are too long (max 5000 characters)' } };
  }
  if (fields.occasion !== undefined && fields.occasion &&
      (typeof fields.occasion !== 'string' || fields.occasion.length > 500)) {
    return { error: { status: 400, message: 'occasion is too long (max 500 characters)' } };
  }

  // Drink window: validate the EFFECTIVE pair (new values overlaying current).
  // parseDrinkYear returns { ok, value } — value undefined for empty input,
  // which here (an explicit null/'' in a PATCH-style update) means CLEAR.
  let fromYear;
  let toYear;
  if (fields.drinkFrom !== undefined) {
    const p = parseDrinkYear(fields.drinkFrom, 'drinkFrom');
    if (!p.ok) return { error: { status: 400, message: p.error } };
    fromYear = p.value !== undefined ? p.value : null;
  }
  if (fields.drinkTo !== undefined) {
    const p = parseDrinkYear(fields.drinkTo, 'drinkTo');
    if (!p.ok) return { error: { status: 400, message: p.error } };
    toYear = p.value !== undefined ? p.value : null;
  }
  const effFrom = fromYear !== undefined ? fromYear : bottle.drinkFrom;
  const effTo = toYear !== undefined ? toYear : bottle.drinkTo;
  if (effFrom && effTo && effFrom > effTo) {
    return { error: { status: 400, message: 'drinkFrom cannot be after drinkTo' } };
  }

  if (fields.rating === null) {
    // Explicit clear — needed so undoing a rating-SET can restore "unrated"
    // (resolveRating treats null as "no input" and would silently skip it,
    // leaving the old rating stranded on a possibly-changed scale).
    // ratingScale may ride along (e.g. restoring the pre-update scale).
  } else if (fields.rating !== undefined) {
    const scale = fields.ratingScale || bottle.ratingScale;
    const resolved = resolveRatingUtil(fields.rating, scale);
    if (resolved.error) return { error: { status: 400, message: resolved.error } };
    fields.rating = resolved.rating;
    fields.ratingScale = resolved.ratingScale;
  } else if (fields.ratingScale !== undefined) {
    return { error: { status: 400, message: 'ratingScale can only be changed together with rating' } };
  }

  const apply = (key, value) => {
    const current = bottle[key] == null ? null : bottle[key];
    const next = value == null ? null : value;
    if (String(current) === String(next)) return;
    prev[key] = bottle[key] === undefined ? null : bottle[key];
    bottle[key] = value;
    changes[key] = value == null ? null : value;
  };

  for (const key of UPDATABLE_FIELDS) {
    if (fields[key] === undefined) continue;
    let value = fields[key];
    if (key === 'notes' || key === 'occasion') value = value ? stripHtml(value) : value;
    if (key === 'drinkFrom') value = fromYear;
    if (key === 'drinkTo') value = toYear;
    apply(key, value);
  }

  if (Object.keys(changes).length === 0) {
    return { bottle, changes, prev };
  }

  // Same semantics as the REST route: a price/currency touch re-anchors the
  // price date (or clears it when the price itself is cleared); a drink-window
  // change resets the notifier markers.
  if ('price' in changes || 'currency' in changes) {
    if ('price' in changes && changes.price === null) {
      bottle.priceSetAt = undefined;
    } else {
      bottle.priceSetAt = new Date();
      require('../utils/exchangeRates').getOrCreateDailySnapshot().catch(() => {});
    }
  }
  if ('drinkFrom' in changes || 'drinkTo' in changes) {
    bottle.drinkWindowNotifiedStatus = null;
    bottle.drinkWindowNotifiedAt = null;
  }

  try {
    await bottle.save();
  } catch (err) {
    if (err?.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    if (err?.name === 'VersionError') return { error: { status: 409, message: 'The bottle was modified concurrently — retry.' } };
    throw err;
  }
  require('./search').indexBottle(bottle._id);
  // Audit in the SAME { field: { from, to } } shape the REST PUT /bottles/:id
  // route emits, so CellarAudit renders both surfaces identically (a bare
  // { field: newValue } here made the page crash when a value was cleared —
  // grand-audit H2). `prev` holds the old value, `changes` the new (null on
  // clear); both carry exactly the keys that changed.
  const auditChanges = {};
  for (const key of Object.keys(changes)) {
    auditChanges[key] = { from: prev[key] ?? null, to: changes[key] };
  }
  logAudit(req, 'bottle.update',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { changes: auditChanges });

  return { bottle, changes, prev };
}

/**
 * Reverse an incorrectly-added ACTIVE bottle — the full cleanup cascade of
 * REST POST /api/bottles/:id/undo (rack slots, search index, own images +
 * file unlink, wine-assigned image unassignment, pending wine request, then
 * the bottle document itself). auditAction distinguishes 'bottle.undo' from
 * 'bottle.delete', which run the identical cascade.
 * Returns { error } | { removed: true }.
 */
async function removeBottleCascade(bottle, req, auditAction) {
  if (bottle.status !== 'active') {
    return { error: { status: 400, message: 'Only an active bottle can be removed this way' } };
  }
  const bottleId = bottle._id;
  const pendingRequestId = bottle.pendingWineRequest || null;

  await removeFromRacks(bottleId);
  require('./search').removeBottle(bottleId);

  const { unlinkImageFiles } = require('./imageProcessor');
  const ownImages = await BottleImage.find({ bottle: bottleId, assignedToWine: false });
  for (const img of ownImages) await unlinkImageFiles(img);
  await BottleImage.deleteMany({ bottle: bottleId, assignedToWine: false });
  await BottleImage.updateMany(
    { bottle: bottleId, assignedToWine: true },
    { $set: { bottle: null } }
  );

  if (pendingRequestId) {
    await WineRequest.deleteOne({ _id: pendingRequestId, status: 'pending' });
  }

  const cellarId = bottle.cellar;
  await bottle.deleteOne();

  logAudit(req, auditAction || 'bottle.undo',
    { type: 'bottle', id: bottleId, cellarId },
    { reason: 'mistake' });

  return { removed: true };
}

module.exports = {
  consumeBottle, restoreBottle, removeFromRacks, RESTORE_WINDOW_MS,
  addBottle, updateBottleFields, removeBottleCascade, UPDATABLE_FIELDS,
};
