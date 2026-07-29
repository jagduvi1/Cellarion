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

// ── Open-bottle (Coravin / preservation) tracking ────────────────────────────
const { PRESERVATION_METHODS, DEFAULT_POUR_ML } = require('../utils/openBottleUtils');
const MAX_POURS = 100;
// How far back an explicit openedAt may be backdated ("I opened it last
// weekend") — matches the longest preservation freshness window (coravin).
const MAX_OPEN_BACKDATE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Mark an ACTIVE bottle as opened (Coravin / re-corked / …). The bottle stays
 * active and keeps its rack slot — it is still physically in the cellar.
 * openedAt is optional backdating (≤90 days, never the future); default now.
 * Mirrors POST /api/bottles/:id/open exactly.
 * Returns { error } | { bottle }.
 */
async function openBottle(bottle, { preservationMethod, openedAt } = {}, req) {
  if (CONSUMED_STATUSES.includes(bottle.status)) {
    return { error: { status: 400, message: 'Bottle is already consumed' } };
  }
  if (bottle.openedAt) {
    return { error: { status: 400, message: 'Bottle is already open', code: 'already_open' } };
  }
  if (!PRESERVATION_METHODS.includes(preservationMethod)) {
    return { error: { status: 400, message: `Invalid preservation method (use one of: ${PRESERVATION_METHODS.join(', ')})` } };
  }
  let at = new Date();
  if (openedAt !== undefined && openedAt !== null) {
    at = new Date(openedAt);
    if (Number.isNaN(at.getTime())) {
      return { error: { status: 400, message: 'openedAt is not a valid date' } };
    }
    if (at.getTime() > Date.now() + 5 * 60 * 1000) {
      return { error: { status: 400, message: 'openedAt cannot be in the future' } };
    }
    if (Date.now() - at.getTime() > MAX_OPEN_BACKDATE_MS) {
      return { error: { status: 400, message: 'openedAt is too far in the past (max 90 days back)' } };
    }
  }
  bottle.openedAt = at;
  bottle.preservationMethod = preservationMethod;
  bottle.pours = [];
  bottle.openBottleNotifiedAt = null; // fresh opening → expiry alert re-arms
  await bottle.save();
  logAudit(req, 'bottle.open',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { preservationMethod }
  );
  return { bottle };
}

/**
 * Record a pour from an OPEN bottle (default: one 125 ml glass).
 * Mirrors POST /api/bottles/:id/pour exactly.
 * Returns { error } | { bottle }.
 */
async function pourFromBottle(bottle, { ml } = {}, req) {
  if (CONSUMED_STATUSES.includes(bottle.status)) {
    return { error: { status: 400, message: 'Bottle is already consumed' } };
  }
  if (!bottle.openedAt) {
    return { error: { status: 400, message: 'Open the bottle first', code: 'not_open' } };
  }
  const amount = ml === undefined || ml === null ? DEFAULT_POUR_ML : Number(ml);
  if (!Number.isFinite(amount) || amount < 1 || amount > 6000) {
    return { error: { status: 400, message: 'Pour must be between 1 and 6000 ml' } };
  }
  if (bottle.pours.length >= MAX_POURS) {
    return { error: { status: 400, message: 'Too many pours recorded for this bottle' } };
  }
  bottle.pours.push({ at: new Date(), ml: Math.round(amount) });
  await bottle.save();
  logAudit(req, 'bottle.pour',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { ml: Math.round(amount) }
  );
  return { bottle };
}

/**
 * Clear a bottle's open state WITHOUT consuming it (accidental open, or the
 * evening is over and the bottle goes back unopened-looking). Clears pours too
 * — callers that need to reverse this get the snapshot back in prevOpenState.
 * Mirrors DELETE /api/bottles/:id/open exactly.
 * Returns { error } | { bottle, prevOpenState }.
 */
async function closeBottle(bottle, req) {
  if (!bottle.openedAt) {
    return { error: { status: 400, message: 'Bottle is not open', code: 'not_open' } };
  }
  const prevOpenState = {
    openedAt: bottle.openedAt,
    preservationMethod: bottle.preservationMethod || null,
    pours: (bottle.pours || []).map((p) => ({ at: p.at, ml: p.ml })),
    openBottleNotifiedAt: bottle.openBottleNotifiedAt || null,
  };
  bottle.openedAt = null;
  bottle.preservationMethod = undefined;
  bottle.pours = [];
  bottle.openBottleNotifiedAt = null;
  await bottle.save();
  logAudit(req, 'bottle.open_undo', { type: 'bottle', id: bottle._id, cellarId: bottle.cellar });
  return { bottle, prevOpenState };
}

/**
 * Create a bottle in an ACCESS-CHECKED cellar for an EXISTING registry wine —
 * the ONE implementation behind REST POST /api/bottles and the MCP add_bottle
 * tool (the route delegates here; H1 of the 2026-07-17 MCP audit). Covers the
 * full REST field surface including the migration helpers (dateAdded backdate,
 * addToHistory + consumed-* fields) and fires the same post-save side effects.
 * The enrichment/embedding calls inherit their internal kill-switch + per-user
 * budget gates.
 *
 * Returns { error: { status, message } } | { bottle }.
 */
async function addBottle(cellarDoc, wineDoc, fields = {}, req) {
  const {
    vintage, price, currency, bottleSize,
    purchaseDate, purchaseLocation, purchaseUrl, location,
    notes, occasion, rating, ratingScale, drinkFrom, drinkTo,
    // Migration helpers — backdate the bottle, or add it directly to history.
    dateAdded, addToHistory,
    consumedAt, consumedReason, consumedNote, consumedRating, consumedRatingScale,
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
  const capped = [
    ['Occasion', occasion], ['Purchase location', purchaseLocation], ['Location', location],
  ];
  for (const [label, value] of capped) {
    if (value && (typeof value !== 'string' || value.length > 500)) {
      return { error: { status: 400, message: `${label} is too long (max 500 characters)` } };
    }
  }
  if (purchaseUrl) {
    if (typeof purchaseUrl !== 'string' || purchaseUrl.length > 2048) {
      return { error: { status: 400, message: 'purchaseUrl is too long (max 2048 characters)' } };
    }
    if (!isSafeUrl(purchaseUrl)) {
      return { error: { status: 400, message: 'purchaseUrl must be a valid http or https URL' } };
    }
  }

  // Add-to-history: reason must be a consumed status; its rating resolves on
  // its own scale, independent of the pre-drink rating above.
  if (addToHistory && consumedReason && !CONSUMED_STATUSES.includes(consumedReason)) {
    return { error: { status: 400, message: 'Invalid consumed reason' } };
  }
  const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumedRatingError } =
    addToHistory
      ? resolveRatingUtil(consumedRating, consumedRatingScale)
      : { rating: undefined, ratingScale: undefined, error: null };
  if (consumedRatingError) return { error: { status: 400, message: consumedRatingError } };

  const hasPrice = price !== undefined && price !== null && price !== '';
  // Ensure today's FX snapshot exists BEFORE responding, so an immediate read
  // of the new bottle can time-anchor its price. Non-fatal: the helper returns
  // null (never throws) when the rates API is down.
  if (hasPrice) await require('../utils/exchangeRates').getOrCreateDailySnapshot();

  const doc = {
    user: cellarDoc.user, // bottle owner = cellar owner, same as the REST route
    cellar: cellarDoc._id,
    wineDefinition: wineDoc._id,
    vintage: parsedVintage.value,
    // Kept even without a price — the add form lets users pick their currency
    // before (or without) entering a price; the schema default fills 'USD'.
    currency: currency || 'USD',
    bottleSize: normalizeBottleSize(bottleSize) || DEFAULT_SIZE,
    purchaseDate: purchaseDate || new Date(), // REST defaults this too
  };
  if (hasPrice) {
    doc.price = price;
    doc.priceSetAt = new Date();
  }
  if (purchaseLocation) doc.purchaseLocation = stripHtml(purchaseLocation);
  if (purchaseUrl) doc.purchaseUrl = purchaseUrl;
  if (location) doc.location = stripHtml(location);
  if (notes) doc.notes = stripHtml(notes);
  if (occasion) doc.occasion = stripHtml(occasion);
  if (resolvedRating !== undefined) {
    doc.rating = resolvedRating;
    doc.ratingScale = resolvedScale;
  }
  if (from.value !== undefined) doc.drinkFrom = from.value;
  if (to.value !== undefined) doc.drinkTo = to.value;

  const bottle = new Bottle(doc);
  // Backdate BEFORE seeding the journey, which anchors on the added date.
  if (dateAdded) bottle.createdAt = new Date(dateAdded);
  // Seed the cellar journey: the bottle enters this cellar at its added date.
  bottle.addedToCellarAt = bottle.createdAt;
  bottle.cellarHistory = [{ cellar: cellarDoc._id, cellarName: cellarDoc.name, enteredAt: bottle.createdAt }];
  // Migration helper: create the bottle directly as consumed history.
  if (addToHistory) {
    const reason = consumedReason || 'drank';
    bottle.status = reason;
    bottle.consumedReason = reason;
    bottle.consumedAt = consumedAt ? new Date(consumedAt) : new Date();
    if (consumedNote) bottle.consumedNote = stripHtml(consumedNote);
    if (resolvedConsumedRating !== undefined) {
      bottle.consumedRating = resolvedConsumedRating;
      bottle.consumedRatingScale = resolvedConsumedScale;
    }
  }
  try {
    await bottle.save();
  } catch (err) {
    if (err?.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    throw err;
  }

  // Post-save side effects, one order for both surfaces. Consumed
  // (add-to-history) bottles ARE indexed too — the History tab's search path
  // filters on status at query time (grand-audit H3).
  require('./search').indexBottle(bottle._id);
  try {
    const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
    await ensurePendingVintageProfile(wineDoc._id, bottle.vintage);
  } catch (err) { /* profile bookkeeping must never fail the add */ }
  // Include wineName so the Cellar Audit page shows what was added, matching
  // the REST POST /bottles audit (grand-audit M5 — AI-added bottles showed a
  // bare vintage with no wine name). wineDoc is the resolved registry wine.
  logAudit(req, addToHistory ? 'bottle.addToHistory' : 'bottle.add',
    { type: 'bottle', id: bottle._id, cellarId: cellarDoc._id },
    { wineName: wineDoc.name, vintage: bottle.vintage });
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

// Every field a bottle update may touch — ONE list for the REST PUT route and
// the MCP update_bottle tool (whose schema exposes the AI-useful subset).
const UPDATABLE_FIELDS = [
  'vintage', 'price', 'currency', 'bottleSize',
  'purchaseDate', 'purchaseLocation', 'purchaseUrl',
  'location', 'notes', 'occasion', 'rating', 'ratingScale',
  'drinkFrom', 'drinkTo',
];

// Normalize a value for change detection: Date objects and ISO-ish strings
// compare by calendar day, and null/undefined/'' collapse to one "empty"
// value — so the web form re-sending an unchanged field (it always sends the
// FULL form) never records a phantom change.
function normForCompare(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    try { return new Date(v).toISOString().slice(0, 10); } catch { return v; }
  }
  return String(v);
}

/**
 * Diff-based partial update of an access-checked bottle — the ONE
 * implementation behind REST PUT /api/bottles/:id and the MCP update_bottle
 * tool (the route delegates here; H1 of the 2026-07-17 MCP audit). Handles
 * the full REST field surface: vintage coercion (+ re-embed on change),
 * bottle-size canonicalization, rating resolution against the bottle's own
 * scale, drink-window ordering + notifier-marker reset, priceSetAt
 * re-anchoring, HTML stripping, re-index, and the { field: { from, to } }
 * audit shape CellarAudit renders.
 * Returns { error } | { bottle, changes, prev }.
 */
async function updateBottleFields(bottle, fields, req) {
  fields = { ...(fields || {}) }; // shallow copy — REST passes req.body
  const changes = {};
  const prev = {};

  if (fields.notes !== undefined && fields.notes &&
      (typeof fields.notes !== 'string' || fields.notes.length > 5000)) {
    return { error: { status: 400, message: 'Notes are too long (max 5000 characters)' } };
  }
  const capped = [
    ['Occasion', fields.occasion], ['Purchase location', fields.purchaseLocation], ['Location', fields.location],
  ];
  for (const [label, value] of capped) {
    if (value && (typeof value !== 'string' || value.length > 500)) {
      return { error: { status: 400, message: `${label} is too long (max 500 characters)` } };
    }
  }
  if (fields.purchaseUrl) {
    if (typeof fields.purchaseUrl !== 'string' || fields.purchaseUrl.length > 2048) {
      return { error: { status: 400, message: 'purchaseUrl is too long (max 2048 characters)' } };
    }
    if (!isSafeUrl(fields.purchaseUrl)) {
      return { error: { status: 400, message: 'purchaseUrl must be a valid http or https URL' } };
    }
  }

  // Vintage: coerce to canonical form ('NV' / 'Unknown' / 'YYYY') or reject.
  if (fields.vintage !== undefined) {
    const p = parseAndValidateVintage(fields.vintage);
    if (!p.ok) return { error: { status: 400, message: p.error } };
    fields.vintage = p.value;
  }
  // Bottle size: canonicalize on the way in (e.g. '1.5L (Magnum)' → '1500ml').
  if (fields.bottleSize !== undefined) {
    fields.bottleSize = normalizeBottleSize(fields.bottleSize) || DEFAULT_SIZE;
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

  if (fields.rating === null || fields.rating === '') {
    // Explicit clear — needed so undoing a rating-SET can restore "unrated"
    // (resolveRating treats null/'' as "no input" and would silently skip it,
    // leaving the old rating stranded on a possibly-changed scale).
    // ratingScale may ride along (e.g. restoring the pre-update scale).
    fields.rating = null;
  } else if (fields.rating !== undefined) {
    const scale = fields.ratingScale || bottle.ratingScale;
    const resolved = resolveRatingUtil(fields.rating, scale);
    if (resolved.error) return { error: { status: 400, message: resolved.error } };
    fields.rating = resolved.rating;
    fields.ratingScale = resolved.ratingScale;
  } else if (fields.ratingScale !== undefined && bottle.rating != null) {
    // A scale change without a rating value would leave the stored rating
    // meaningless on the new scale (e.g. a 4/5 persisted as 4 on the 100
    // scale, later clamped by toNormalized) — require both together. On an
    // UNRATED bottle a scale-only change is harmless and allowed (the web
    // form always sends the scale).
    return { error: { status: 400, message: 'Send rating together with ratingScale when changing the rating scale' } };
  }

  const apply = (key, value) => {
    if (normForCompare(bottle[key]) === normForCompare(value)) return;
    prev[key] = bottle[key] === undefined ? null : bottle[key];
    bottle[key] = value;
    changes[key] = value === '' || value == null ? null : value;
  };

  for (const key of UPDATABLE_FIELDS) {
    if (fields[key] === undefined) continue;
    let value = fields[key];
    if (key === 'notes' || key === 'occasion' || key === 'purchaseLocation' || key === 'location') {
      value = value ? stripHtml(value) : value;
    }
    if (key === 'drinkFrom') value = fromYear;
    if (key === 'drinkTo') value = toYear;
    apply(key, value);
  }

  if (Object.keys(changes).length === 0) {
    return { bottle, changes, prev };
  }

  // A price/currency CHANGE re-anchors the price date (or clears it when the
  // price itself is gone). Deliberately change-based, not presence-based: the
  // web form re-sends every field on save, and a presence-based re-anchor
  // moved the FX anchor date on every unrelated edit. The snapshot is awaited
  // so an immediate read can time-anchor (non-fatal — returns null, never
  // throws, when the rates API is down).
  if ('price' in changes || 'currency' in changes) {
    if (bottle.price !== null && bottle.price !== undefined && bottle.price !== '') {
      bottle.priceSetAt = new Date();
      await require('../utils/exchangeRates').getOrCreateDailySnapshot();
    } else {
      bottle.priceSetAt = undefined;
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
    if (err?.name === 'VersionError') return { error: { status: 409, message: 'This bottle was modified by another request. Please refresh and try again.' } };
    throw err;
  }
  require('./search').indexBottle(bottle._id);
  // Vintage changed: the old (wine, oldVintage) embedding is still in Qdrant
  // but no longer matches this bottle — embed the new pair. Skipped for demo
  // accounts (a novel year misses the cache and would fire a paid Voyage call).
  if ('vintage' in changes && !req?.user?.isDemo) {
    const wineId = bottle.wineDefinition && (bottle.wineDefinition._id || bottle.wineDefinition);
    if (wineId) {
      const { embedSinglePair } = require('./embeddingJob');
      embedSinglePair(wineId, bottle.vintage).catch(() => {});
    }
  }
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
  openBottle, pourFromBottle, closeBottle,
  PRESERVATION_METHODS, DEFAULT_POUR_ML, MAX_POURS,
};
