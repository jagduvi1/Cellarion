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
// services/restockChecker is required LAZILY inside the functions. Anything
// that reaches the ESM-only meilisearch package (services/search) must never be
// a top-level require here: jest cannot parse it, and it would break every
// suite that loads the MCP tool registry (the #702 failure mode).
const { CONSUMED_STATUSES, ORDERED_STATUS } = require('../config/constants');
const { resolveRating } = require('../utils/ratingUtils');
const resolveRatingUtil = resolveRating;
const { stripHtml, isSafeUrl } = require('../utils/sanitize');
const { parseAndValidateVintage, parseDrinkYear } = require('../utils/validation');
const { normalizeBottleSize, DEFAULT_SIZE } = require('../config/bottleSizes');
const { normalizeBarcode } = require('../utils/barcode');
const { parseExpectedArrival } = require('../utils/onOrder');
const { logAudit } = require('./audit');
const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');

// Restores are "undo an accidental log", not resurrection of a bottle drunk
// long ago (see the /restore route docs). Shared so REST and MCP agree.
const RESTORE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// A bottle on order is not in the cellar yet: nothing can be drunk, opened,
// poured or closed until it is marked as arrived. One error for REST and MCP.
const NOT_ARRIVED_ERROR = Object.freeze({
  status: 409,
  code: 'not_arrived',
  message: 'This bottle is on order and has not arrived yet. Mark it as arrived first.',
});

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
// A bare calendar date (YYYY-MM-DD — what <input type="date">, the bulk
// action and the MCP tool send) names a DAY, not an instant. Parse it as NOON
// UTC so it renders as that same day in every zone from UTC-12 to UTC+11:
// `new Date('2026-09-13')` is UTC midnight, which toLocaleDateString shows as
// the 12th to everyone west of Greenwich (audit 2026-09-14 H1 — the default
// "today" would have been a day off for the whole Americas cohort). A full
// timestamp passes through unchanged.
const DAY_ONLY_RX = /^\d{4}-\d{2}-\d{2}$/;
// "Not in the future" slack: a UTC+14 user at 00:01 local is 26 h before
// their own day's noon UTC, so 36 h rather than 24.
const FUTURE_SLACK_MS = 36 * 60 * 60 * 1000;
function parseConsumedAt(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  return new Date(typeof raw === 'string' && DAY_ONLY_RX.test(raw) ? `${raw}T12:00:00Z` : raw);
}

async function consumeBottle(bottle, { reason = 'drank', note, rating, ratingScale, consumedAt, skipRestockCheck = false } = {}, req) {
  if (bottle.status === ORDERED_STATUS) return { error: { ...NOT_ARRIVED_ERROR } };
  if (!CONSUMED_STATUSES.includes(reason)) {
    return { error: { status: 400, message: 'Invalid reason' } };
  }
  if (note && (typeof note !== 'string' || note.length > 1000)) {
    return { error: { status: 400, message: 'Note is too long (max 1000 characters)' } };
  }
  const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } =
    resolveRating(rating, ratingScale);
  if (ratingError) return { error: { status: 400, message: ratingError } };

  // Optional explicit date — the bulk "mark as drunk" puts ONE date on a whole
  // selection (the dinner was last Saturday, the logging is today). Defaults
  // to now; never in the future, never before the app's earliest vintage year.
  let when = new Date();
  if (consumedAt !== undefined && consumedAt !== null && consumedAt !== '') {
    const d = parseConsumedAt(consumedAt);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + FUTURE_SLACK_MS || d.getFullYear() < 1900) {
      return { error: { status: 400, message: 'consumedAt must be a valid date and not in the future' } };
    }
    when = d;
  }

  bottle.status = reason;
  bottle.consumedAt = when;
  // When the consume was LOGGED — always now — as distinct from the date the
  // user put on it. The restore window counts from this (see restoreBottle).
  bottle.consumedLoggedAt = new Date();
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

  logAudit(req, 'bottle.consume',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { reason }
  );

  // Fire-and-forget restock-gap check. Skipped for demo accounts: on an
  // un-cached (wine, vintage) pair this fires a paid Voyage embedding call,
  // which would breach the demo's "zero AI spend" guarantee.
  // skipRestockCheck: the bulk route runs one check per wine+vintage itself.
  if (reason === 'drank' && !skipRestockCheck && !req?.user?.isDemo) {
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
  // The window counts from when the consume was LOGGED, not from the date the
  // user put on it — a bulk "drunk last Saturday" entered today is still an
  // accidental log for two days. Rows from before consumedLoggedAt existed
  // fall back to consumedAt, which was always "now" then.
  const loggedAt = bottle.consumedLoggedAt || bottle.consumedAt;
  if (loggedAt && (Date.now() - new Date(loggedAt).getTime()) > RESTORE_WINDOW_MS) {
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
  bottle.consumedLoggedAt = undefined;
  bottle.consumedReason = undefined;
  bottle.consumedNote = undefined;
  bottle.consumedRating = undefined;
  bottle.consumedRatingScale = undefined;
  await bottle.save();

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
  if (bottle.status === ORDERED_STATUS) return { error: { ...NOT_ARRIVED_ERROR } };
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
 * Record pours from an OPEN bottle (default: one 125 ml glass). `count`
 * records a whole batch ALL-OR-NOTHING in one save — validation covers the
 * full batch up front, so there is never a partially-committed batch (the
 * MCP pour_glass ledger row can then always say recorded = requested).
 * Mirrors POST /api/bottles/:id/pour exactly (REST always passes count 1).
 * Returns { error } | { bottle }.
 */
async function pourFromBottle(bottle, { ml, count } = {}, req) {
  if (bottle.status === ORDERED_STATUS) return { error: { ...NOT_ARRIVED_ERROR } };
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
  const glasses = count === undefined || count === null ? 1 : Number(count);
  if (!Number.isInteger(glasses) || glasses < 1 || glasses > 10) {
    return { error: { status: 400, message: 'count must be an integer between 1 and 10' } };
  }
  if (bottle.pours.length + glasses > MAX_POURS) {
    return { error: { status: 400, message: 'Too many pours recorded for this bottle' } };
  }
  const at = new Date();
  for (let i = 0; i < glasses; i += 1) {
    bottle.pours.push({ at, ml: Math.round(amount) });
  }
  await bottle.save();
  logAudit(req, 'bottle.pour',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { ml: Math.round(amount), ...(glasses > 1 ? { count: glasses } : {}) }
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
  // A consumed bottle KEEPS openedAt/preservationMethod/pours as drinking
  // history on its consumption record (Bottle schema) — those fields are no
  // longer current state, so clearing them destroys the record rather than
  // undoing a mistake. openBottle/pourFromBottle already gate on this; the
  // guard belongs here rather than in the callers so REST and MCP inherit one
  // implementation (security audit 2026-07-30 M-1: #866 fixed the MCP tools
  // one at a time, which left DELETE /api/bottles/:id/open with no guard at
  // all). To reverse the consume itself, restore the bottle first.
  if (CONSUMED_STATUSES.includes(bottle.status)) {
    return { error: {
      status: 409,
      code: 'consumed',
      message: 'This bottle was already consumed — its open-bottle fields are preserved drinking history, not current state. Restore the bottle first if the consume was a mistake.',
    } };
  }
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
/**
 * Checks-only validation of the bottle-create field surface — no values are
 * produced and nothing is written. Exists so the POST /api/bottles newWine
 * branch can validate the COMMIT fields BEFORE resolveOrMintWine runs
 * (release-audit LOW-1: a field 400 after the mint would leave the exact
 * orphan mint-at-commit exists to prevent). addBottle still runs its own
 * inline validation+resolution afterwards — this is a pre-mint gate, not a
 * replacement, and the parsers are pure so double-parsing is free.
 */
/**
 * Validate the optional personal peak (peakFrom/peakUntil) against its
 * enclosing drink window. Returns { error } on a fault, or the parsed
 * { peakFrom, peakUntil } values ({ ok } shape mirrors parseDrinkYear's
 * undefined-for-empty convention). Ordering enforced:
 * drinkFrom ≤ peakFrom ≤ peakUntil ≤ drinkTo.
 */
function validatePeakWindow(peakFromRaw, peakUntilRaw, fromValue, toValue) {
  const pFrom = parseDrinkYear(peakFromRaw, 'peakFrom');
  if (!pFrom.ok) return { error: { status: 400, message: pFrom.error } };
  const pUntil = parseDrinkYear(peakUntilRaw, 'peakUntil');
  if (!pUntil.ok) return { error: { status: 400, message: pUntil.error } };
  if (pFrom.value && pUntil.value && pFrom.value > pUntil.value) {
    return { error: { status: 400, message: 'peakFrom cannot be after peakUntil' } };
  }
  if (fromValue && pFrom.value && pFrom.value < fromValue) {
    return { error: { status: 400, message: 'peakFrom cannot be before drinkFrom' } };
  }
  if (toValue && pUntil.value && pUntil.value > toValue) {
    return { error: { status: 400, message: 'peakUntil cannot be after drinkTo' } };
  }
  return { peakFrom: pFrom.value, peakUntil: pUntil.value };
}

/**
 * The on-order pair of the bottle-create surface: `onOrder: true` creates the
 * bottle as bought-not-delivered (status 'ordered'), with an optional
 * `expectedArrival` month. A bottle cannot be on order and already drunk.
 * Returns { error } | { onOrder: boolean, expectedArrival: Date|null }.
 */
function parseOnOrderFields({ onOrder, expectedArrival, addToHistory } = {}) {
  const on = onOrder === true || onOrder === 'true';
  if (!on) return { onOrder: false, expectedArrival: null };
  if (addToHistory) {
    return { error: { status: 400, message: 'A bottle cannot be both on order and added to history' } };
  }
  const ea = parseExpectedArrival(expectedArrival);
  if (!ea.ok) return { error: { status: 400, message: ea.error } };
  return { onOrder: true, expectedArrival: ea.value };
}

function validateBottleCommitFields(fields = {}) {
  const {
    vintage, purchaseLocation, purchaseUrl, location,
    notes, occasion, rating, ratingScale, drinkFrom, drinkTo, peakFrom, peakUntil,
    addToHistory, consumedReason, consumedRating, consumedRatingScale,
    onOrder, expectedArrival,
  } = fields;

  const parsedVintage = parseAndValidateVintage(vintage);
  if (!parsedVintage.ok) return { error: { status: 400, message: parsedVintage.error } };
  const orderCheck = parseOnOrderFields({ onOrder, expectedArrival, addToHistory });
  if (orderCheck.error) return orderCheck;
  const from = parseDrinkYear(drinkFrom, 'drinkFrom');
  if (!from.ok) return { error: { status: 400, message: from.error } };
  const to = parseDrinkYear(drinkTo, 'drinkTo');
  if (!to.ok) return { error: { status: 400, message: to.error } };
  if (from.value && to.value && from.value > to.value) {
    return { error: { status: 400, message: 'drinkFrom cannot be after drinkTo' } };
  }
  // Optional peak INSIDE the window — the personal twin of the somm profile's
  // five-stage shape (ticket 6a94655283: "drinkable ≠ peak"). Ordering:
  // drinkFrom ≤ peakFrom ≤ peakUntil ≤ drinkTo.
  const pw = validatePeakWindow(peakFrom, peakUntil, from.value, to.value);
  if (pw.error) return pw;
  const { error: ratingError } = resolveRatingUtil(rating, ratingScale);
  if (ratingError) return { error: { status: 400, message: ratingError } };
  if (notes && (typeof notes !== 'string' || notes.length > 5000)) {
    return { error: { status: 400, message: 'Notes are too long (max 5000 characters)' } };
  }
  for (const [label, value] of [
    ['Occasion', occasion], ['Purchase location', purchaseLocation], ['Location', location],
  ]) {
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
  if (addToHistory && consumedReason && !CONSUMED_STATUSES.includes(consumedReason)) {
    return { error: { status: 400, message: 'Invalid consumed reason' } };
  }
  if (addToHistory) {
    const { error: consumedRatingError } = resolveRatingUtil(consumedRating, consumedRatingScale);
    if (consumedRatingError) return { error: { status: 400, message: consumedRatingError } };
  }
  return { ok: true };
}

async function addBottle(cellarDoc, wineDoc, fields = {}, req) {
  const {
    vintage, price, currency, bottleSize,
    purchaseDate, purchaseLocation, purchaseUrl, location,
    notes, occasion, rating, ratingScale, drinkFrom, drinkTo, peakFrom, peakUntil,
    // Migration helpers — backdate the bottle, or add it directly to history.
    dateAdded, addToHistory,
    consumedAt, consumedReason, consumedNote, consumedRating, consumedRatingScale,
    barcode,
    // Bought, not delivered yet (en primeur, a pre-order): status 'ordered'.
    onOrder, expectedArrival,
  } = fields;

  const parsedVintage = parseAndValidateVintage(vintage);
  if (!parsedVintage.ok) return { error: { status: 400, message: parsedVintage.error } };
  const order = parseOnOrderFields({ onOrder, expectedArrival, addToHistory });
  if (order.error) return order;

  const from = parseDrinkYear(drinkFrom, 'drinkFrom');
  if (!from.ok) return { error: { status: 400, message: from.error } };
  const to = parseDrinkYear(drinkTo, 'drinkTo');
  if (!to.ok) return { error: { status: 400, message: to.error } };
  if (from.value && to.value && from.value > to.value) {
    return { error: { status: 400, message: 'drinkFrom cannot be after drinkTo' } };
  }
  // Same peak validation as validateBottleCommitFields — one helper, two callers.
  const pw = validatePeakWindow(peakFrom, peakUntil, from.value, to.value);
  if (pw.error) return pw;

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
  // A scanned retail barcode. Never a reason to refuse an add: a code that is
  // not a valid public GTIN (misread, shop-internal) is simply not stored.
  const code = normalizeBarcode(barcode);
  if (code) doc.barcode = code;
  if (location) doc.location = stripHtml(location);
  if (notes) doc.notes = stripHtml(notes);
  if (occasion) doc.occasion = stripHtml(occasion);
  if (resolvedRating !== undefined) {
    doc.rating = resolvedRating;
    doc.ratingScale = resolvedScale;
  }
  if (from.value !== undefined) doc.drinkFrom = from.value;
  if (to.value !== undefined) doc.drinkTo = to.value;
  if (pw.peakFrom !== undefined) doc.peakFrom = pw.peakFrom;
  if (pw.peakUntil !== undefined) doc.peakUntil = pw.peakUntil;

  const bottle = new Bottle(doc);
  // Backdate BEFORE seeding the journey, which anchors on the added date.
  if (dateAdded) bottle.createdAt = new Date(dateAdded);
  // Seed the cellar journey: the bottle enters this cellar at its added date.
  bottle.addedToCellarAt = bottle.createdAt;
  bottle.cellarHistory = [{ cellar: cellarDoc._id, cellarName: cellarDoc.name, enteredAt: bottle.createdAt }];
  // On order: in this cellar's books but not on its shelves until it arrives.
  if (order.onOrder) {
    bottle.status = ORDERED_STATUS;
    if (order.expectedArrival) bottle.expectedArrival = order.expectedArrival;
  }
  // Migration helper: create the bottle directly as consumed history.
  if (addToHistory) {
    const reason = consumedReason || 'drank';
    bottle.status = reason;
    bottle.consumedReason = reason;
    bottle.consumedAt = consumedAt ? parseConsumedAt(consumedAt) : new Date();
    bottle.consumedLoggedAt = new Date();
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

  // Post-save side effects, one order for both surfaces.
  // A bottle ON ORDER is not queued for a sommelier drink window yet: an en
  // primeur vintage may not even be released, so there is nothing to judge.
  // markArrived queues it the day it arrives.
  if (!order.onOrder) {
    try {
      const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
      await ensurePendingVintageProfile(wineDoc._id, bottle.vintage);
    } catch (err) { /* profile bookkeeping must never fail the add */ }
  }
  // A bottle added to the creator's private draft is a "touch": the draft's
  // untouched clock restarts (draft design 2026-09-12). Best-effort.
  if (wineDoc.draft === true) {
    try { await require('./wineDraftOps').touchDraft(wineDoc._id); } catch { /* never fails the add */ }
  }
  // Include wineName so the Cellar Audit page shows what was added, matching
  // the REST POST /bottles audit (grand-audit M5 — AI-added bottles showed a
  // bare vintage with no wine name). wineDoc is the resolved registry wine.
  logAudit(req, addToHistory ? 'bottle.addToHistory' : 'bottle.add',
    { type: 'bottle', id: bottle._id, cellarId: cellarDoc._id },
    { wineName: wineDoc.name, vintage: bottle.vintage, ...(order.onOrder ? { onOrder: true } : {}) });
  // Fire-and-forget AI enrichment — both calls carry their own kill-switch /
  // per-user budget gates (embeddingJob: chatEnabled; enrichmentJob: tryDebitAi).
  const { embedSinglePair } = require('./embeddingJob');
  embedSinglePair(wineDoc._id, bottle.vintage).catch(() => {});
  const { enrichWineById } = require('./enrichmentJob');
  // trigger:'add' — subject to the enrichmentOnAdd policy (aiConfig).
  enrichWineById(wineDoc._id, { budgetUserId: req && req.user ? req.user.id : undefined, trigger: 'add' }).catch(() => {});
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
  'drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil', 'reservedFor', 'reservedUntil',
  // Only on a bottle still on order; ignored on any other (see below).
  'expectedArrival',
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
  // An UNCHANGED vintage is never re-validated: the web form sends the whole
  // form on every save, and a bottle stored under an older rule (2028 was
  // legal when the cap was harvest year + 5) must stay editable — a price
  // change is not the moment to argue about its vintage (audit 2026-09-07).
  if (fields.vintage !== undefined && String(fields.vintage).trim() === String(bottle.vintage ?? '').trim()) {
    delete fields.vintage;
  } else if (fields.vintage !== undefined) {
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

  // Personal peak (peakFrom/peakUntil): same PATCH semantics as the window —
  // explicit null/'' clears — and the ordering check runs on the EFFECTIVE
  // values so a drinkFrom edit cannot silently invert an existing peak.
  let peakFromYear;
  let peakUntilYear;
  if (fields.peakFrom !== undefined) {
    const p = parseDrinkYear(fields.peakFrom, 'peakFrom');
    if (!p.ok) return { error: { status: 400, message: p.error } };
    peakFromYear = p.value !== undefined ? p.value : null;
  }
  if (fields.peakUntil !== undefined) {
    const p = parseDrinkYear(fields.peakUntil, 'peakUntil');
    if (!p.ok) return { error: { status: 400, message: p.error } };
    peakUntilYear = p.value !== undefined ? p.value : null;
  }
  const effPeakFrom  = peakFromYear  !== undefined ? peakFromYear  : bottle.peakFrom;
  const effPeakUntil = peakUntilYear !== undefined ? peakUntilYear : bottle.peakUntil;
  if (effPeakFrom && effPeakUntil && effPeakFrom > effPeakUntil) {
    return { error: { status: 400, message: 'peakFrom cannot be after peakUntil' } };
  }
  if (effFrom && effPeakFrom && effPeakFrom < effFrom) {
    return { error: { status: 400, message: 'peakFrom cannot be before drinkFrom' } };
  }
  if (effTo && effPeakUntil && effPeakUntil > effTo) {
    return { error: { status: 400, message: 'peakUntil cannot be after drinkTo' } };
  }

  // Reservation ("spoken for"): reservedFor is capped free text, reservedUntil
  // a calendar year like drinkFrom/drinkTo. An explicit null/'' clears.
  if (fields.reservedFor !== undefined && fields.reservedFor &&
      (typeof fields.reservedFor !== 'string' || fields.reservedFor.length > 200)) {
    return { error: { status: 400, message: 'Reserved-for note is too long (max 200 characters)' } };
  }
  let reservedUntilYear;
  if (fields.reservedUntil !== undefined) {
    const p = parseDrinkYear(fields.reservedUntil, 'reservedUntil');
    if (!p.ok) return { error: { status: 400, message: p.error } };
    reservedUntilYear = p.value !== undefined ? p.value : null;
  }

  // Expected arrival (a month) belongs to a bottle on order. On any other
  // bottle it is dropped, not refused: the field means nothing once the
  // bottle is in the cellar, and a bulk edit can span both.
  if (fields.expectedArrival !== undefined) {
    if (bottle.status !== ORDERED_STATUS) {
      delete fields.expectedArrival;
    } else {
      const p = parseExpectedArrival(fields.expectedArrival);
      if (!p.ok) return { error: { status: 400, message: p.error } };
      fields.expectedArrival = p.value;
    }
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
    if (key === 'notes' || key === 'occasion' || key === 'purchaseLocation' || key === 'location' || key === 'reservedFor') {
      value = value ? stripHtml(value) : value;
    }
    if (key === 'drinkFrom') value = fromYear;
    if (key === 'drinkTo') value = toYear;
    if (key === 'peakFrom') value = peakFromYear;
    if (key === 'peakUntil') value = peakUntilYear;
    if (key === 'reservedUntil') value = reservedUntilYear;
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
  // A reserved-until change re-arms the one-shot reservation alert (same
  // pattern as the drink-window markers above).
  if ('reservedUntil' in changes) {
    bottle.reservationNotifiedAt = null;
  }
  // A new expected month re-arms the "should have arrived by now" reminder.
  if ('expectedArrival' in changes) {
    bottle.arrivalNotifiedAt = undefined;
  }

  try {
    await bottle.save();
  } catch (err) {
    if (err?.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    if (err?.name === 'VersionError') return { error: { status: 409, message: 'This bottle was modified by another request. Please refresh and try again.' } };
    throw err;
  }
  if ('vintage' in changes) {
    // The bottle's photos are photos of THIS bottle, so they follow its
    // vintage (support ticket 2026-10-09: same-vintage photos are preferred
    // over the wine's generic image). Bookkeeping: never fails the edit.
    try {
      const { photoVintage } = require('../utils/imageVintage');
      await BottleImage.updateMany({ bottle: bottle._id }, { $set: { vintage: photoVintage(bottle.vintage) } });
    } catch (err) {
      console.error('Photo vintage sync failed:', err.message);
    }
    const wineId = bottle.wineDefinition && (bottle.wineDefinition._id || bottle.wineDefinition);
    if (wineId) {
      // The new (wine, vintage) is a pair a sommelier may never have seen:
      // queue it for a drink window exactly as adding a bottle of it would
      // (addBottle), and with the same exception — a bottle on order is
      // queued the day it arrives (markArrived). Until 2026-10-09 an edited
      // vintage never reached the queue, from the app or over MCP.
      if (bottle.status !== ORDERED_STATUS) {
        try {
          await require('../utils/vintageProfile').ensurePendingVintageProfile(wineId, bottle.vintage);
        } catch { /* queue bookkeeping must never fail the edit */ }
      }
      // The old (wine, oldVintage) embedding is still stored but no longer
      // matches this bottle — embed the new pair. Skipped for demo accounts
      // (a novel year misses the cache and would fire a paid Voyage call).
      if (!req?.user?.isDemo) {
        const { embedSinglePair } = require('./embeddingJob');
        embedSinglePair(wineId, bottle.vintage).catch(() => {});
      }
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
 * REST POST /api/bottles/:id/undo (rack slots, own images +
 * file unlink, wine-assigned image unassignment, pending wine request, then
 * the bottle document itself). auditAction distinguishes 'bottle.undo' from
 * 'bottle.delete', which run the identical cascade.
 * options.anyStatus also removes a consumed bottle (a duplicate history row
 * from an import is deleted the same way); options.auditDetail replaces the
 * default { reason: 'mistake' }.
 * Returns { error } | { removed: true }.
 */
async function removeBottleCascade(bottle, req, auditAction, options = {}) {
  // A bottle on order qualifies too: a cancelled order is removed this way.
  if (!options.anyStatus && bottle.status !== 'active' && bottle.status !== ORDERED_STATUS) {
    return { error: { status: 400, message: 'Only an active bottle can be removed this way' } };
  }
  const bottleId = bottle._id;
  const pendingRequestId = bottle.pendingWineRequest || null;

  await removeFromRacks(bottleId);

  const { unlinkImageFiles } = require('./imageProcessor');
  // The user's own photos go with the bottle; registry photos (the wine's
  // picture, or any photo approved as public — services/photoRetention) are
  // kept and detached, other people see them.
  const { REGISTRY_PHOTO, OWN_PHOTO } = require('./photoRetention');
  const ownImages = await BottleImage.find({ bottle: bottleId, ...OWN_PHOTO });
  for (const img of ownImages) await unlinkImageFiles(img);
  await BottleImage.deleteMany({ bottle: bottleId, ...OWN_PHOTO });
  await BottleImage.updateMany(
    { bottle: bottleId, ...REGISTRY_PHOTO },
    { $set: { bottle: null } }
  );

  const cellarId = bottle.cellar;
  await bottle.deleteOne();

  // Only remove the request if THIS was the last bottle waiting on it.
  //
  // One request covers every bottle of a wine in an import — /confirm dedups
  // by (wineName, producer) — so deleting the request outright took the whole
  // group down with a single bottle. The siblings kept a pendingWineRequest
  // pointing at nothing: no wineDefinition, no live request, nameless in the
  // cellar AND invisible to the admin queue that would have named them.
  // Observed on prod 2026-08-30, where removing a few duplicate bottles
  // orphaned four others and dropped the user's request count by eight.
  //
  // Counted AFTER the bottle is deleted, so this row cannot count itself.
  // A request nobody is waiting on any more is still deleted — that is the
  // behaviour this preserves, and it is what keeps the admin queue free of
  // requests for bottles that no longer exist.
  if (pendingRequestId) {
    const stillWaiting = await Bottle.countDocuments({ pendingWineRequest: pendingRequestId });
    if (stillWaiting === 0) {
      await WineRequest.deleteOne({ _id: pendingRequestId, status: 'pending' });
    }
  }

  logAudit(req, auditAction || 'bottle.undo',
    { type: 'bottle', id: bottleId, cellarId },
    options.auditDetail || { reason: 'mistake' });

  return { removed: true };
}

/**
 * What an undo needs to bring a deleted bottle back (MCP delete_bottle):
 * the bottle document as stored, its rack slot, the registry photos it
 * points at, and an import request the delete is about to withdraw (no other
 * bottle waits on it). Taken BEFORE the delete, and the caller stores it
 * before deleting anything — a bottle must never be gone without its way back.
 *
 * Restoring with the SAME _id reconnects everything else that refers to the
 * bottle by id (tasting notes, personal data, lists). The owner's own photos
 * cannot come back: the delete removes their files. ownPhotos says how many
 * that is, so the caller can say so first.
 * Returns { snapshot, ownPhotos }.
 */
async function snapshotBottleForDelete(bottle) {
  const { REGISTRY_PHOTO, OWN_PHOTO } = require('./photoRetention');
  const raw = typeof bottle.toObject === 'function'
    ? bottle.toObject({ depopulate: true, virtuals: false })
    : { ...bottle };
  const rack = await Rack.findOne({ 'slots.bottle': bottle._id }).select('_id slots').lean();
  const slot = rack ? (rack.slots || []).find((s) => String(s.bottle) === String(bottle._id)) : null;
  const registryPhotos = await BottleImage.find({ bottle: bottle._id, ...REGISTRY_PHOTO }).select('_id').lean();
  const ownPhotos = await BottleImage.countDocuments({ bottle: bottle._id, ...OWN_PHOTO });
  let wineRequest = null;
  if (bottle.pendingWineRequest) {
    const others = await Bottle.countDocuments({ pendingWineRequest: bottle.pendingWineRequest, _id: { $ne: bottle._id } });
    if (others === 0) wineRequest = await WineRequest.findOne({ _id: bottle.pendingWineRequest, status: 'pending' }).lean();
  }
  return {
    snapshot: {
      bottle: raw,
      rack: slot ? { rackId: rack._id, position: slot.position } : null,
      registryPhotoIds: registryPhotos.map((p) => p._id),
      wineRequest,
    },
    ownPhotos,
  };
}

/**
 * Bring back a bottle from a snapshotBottleForDelete snapshot, under its
 * original _id. Refuses (409) when the world moved on: the id is in use
 * again, the cellar is gone, or the wine was merged away or removed since.
 * Access is the caller's to check (the cellar's editor role).
 *
 * The bottle insert is the one step that decides success, so it runs first;
 * everything after it (registry photos re-linked, a withdrawn request
 * recreated, the rack slot re-taken while it is still free) is best effort
 * and never throws, so a hiccup there can't leave the bottle back while the
 * undo looks failed. A default photo that was one of the deleted own photos
 * is dropped rather than restored as a dangling id.
 * Returns { error } | { bottle, placed, position }.
 */
async function restoreDeletedBottle(snapshot, req) {
  const raw = snapshot && snapshot.bottle ? { ...snapshot.bottle } : null;
  if (!raw || !raw._id) return { error: { status: 409, message: 'There is no snapshot to restore from' } };
  if (await Bottle.exists({ _id: raw._id })) {
    return { error: { status: 409, message: 'The bottle already exists again' } };
  }
  const Cellar = require('../models/Cellar');
  if (!(await Cellar.exists({ _id: raw.cellar, deletedAt: null }))) {
    return { error: { status: 409, message: 'Its cellar no longer exists' } };
  }
  if (raw.wineDefinition) {
    const WineDefinition = require('../models/WineDefinition');
    if (!(await WineDefinition.exists({ _id: raw.wineDefinition }))) {
      return { error: { status: 409, message: 'Its wine has been merged or removed from the registry since' } };
    }
  }
  if (raw.defaultImage && !(await BottleImage.exists({ _id: raw.defaultImage }))) {
    raw.defaultImage = null;
  }
  // The stored document as it was: same id, same dates, no defaults re-run.
  await Bottle.collection.insertOne(raw);

  const bestEffort = async (label, fn) => {
    try { return await fn(); } catch (err) {
      console.warn(`[bottleOps] restore of ${raw._id}: ${label} failed (bottle is back):`, err.message);
      return null;
    }
  };
  if (snapshot.registryPhotoIds && snapshot.registryPhotoIds.length) {
    await bestEffort('registry photo re-link', () => BottleImage.updateMany(
      { _id: { $in: snapshot.registryPhotoIds }, bottle: null }, { $set: { bottle: raw._id } }));
  }
  if (snapshot.wineRequest) {
    await bestEffort('wine request recreate', async () => {
      if (!(await WineRequest.exists({ _id: snapshot.wineRequest._id }))) {
        await WineRequest.collection.insertOne(snapshot.wineRequest);
      }
    });
  }
  let placed = false;
  if (snapshot.rack && raw.status === 'active') {
    placed = !!(await bestEffort('rack slot', async () => {
      const rack = await Rack.findOne({ _id: snapshot.rack.rackId, deletedAt: null });
      const taken = rack && (rack.slots || []).some((s) => s.position === snapshot.rack.position);
      if (!rack || taken) return false;
      // Lazy: services/rackOps top-requires this module.
      const { placeBottleInRack } = require('./rackOps');
      const r = await placeBottleInRack(rack, snapshot.rack.position, raw._id, req);
      return !r.error;
    }));
  }
  logAudit(req, 'bottle.restore_deleted',
    { type: 'bottle', id: raw._id, cellarId: raw.cellar },
    { via: 'undo', placed });
  const bottle = (await bestEffort('reload', () => Bottle.findById(raw._id))) || raw;
  return { bottle, placed, position: placed ? snapshot.rack.position : null };
}

/**
 * A bottle on order has been delivered: status ordered → active. It lands
 * UNPLACED in its cellar, like a moved or restored bottle, and from now on
 * counts everywhere an active bottle does. `arrivedAt` is an optional day
 * ("it came on Friday"), never in the future; default now. The order date
 * stays purchaseDate/createdAt; addedToCellarAt, "when it entered this
 * cellar", becomes the delivery day.
 * Mirrors POST /api/bottles/:id/arrive and the bulk 'arrive' action.
 * Returns { error } | { bottle }.
 */
async function markArrived(bottle, { arrivedAt } = {}, req) {
  if (bottle.status !== ORDERED_STATUS) {
    return { error: { status: 409, code: 'not_on_order', message: 'This bottle is not on order' } };
  }
  let when = new Date();
  if (arrivedAt !== undefined && arrivedAt !== null && arrivedAt !== '') {
    const d = parseConsumedAt(arrivedAt);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + FUTURE_SLACK_MS || d.getFullYear() < 1990) {
      return { error: { status: 400, message: 'arrivedAt must be a valid date and not in the future' } };
    }
    // Not before the order itself (compared by day: an order placed this
    // afternoon may arrive "today", noon UTC).
    const orderedOn = bottle.createdAt ? new Date(bottle.createdAt).toISOString().slice(0, 10) : null;
    if (orderedOn && d.toISOString().slice(0, 10) < orderedOn) {
      return { error: { status: 400, message: 'arrivedAt cannot be before the bottle was ordered' } };
    }
    when = d;
  }
  const expected = bottle.expectedArrival || null;
  bottle.status = 'active';
  bottle.arrivedAt = when;
  bottle.addedToCellarAt = when;
  bottle.arrivalNotifiedAt = undefined;
  try {
    await bottle.save();
  } catch (err) {
    if (err?.name === 'VersionError') return { error: { status: 409, message: 'This bottle was modified by another request. Please refresh and try again.' } };
    throw err;
  }
  logAudit(req, 'bottle.arrive',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { ...(expected ? { expectedArrival: expected } : {}) });
  // In the cellar now: THIS is when its vintage enters the sommelier maturity
  // queue (a bottle on order never does — an en primeur vintage may not be
  // released yet), and the pair is embedded as an add does. Both are
  // idempotent and never fail the arrival; the embedding is skipped for demo
  // accounts (zero AI spend).
  const wineId = bottle.wineDefinition && (bottle.wineDefinition._id || bottle.wineDefinition);
  if (wineId) {
    try {
      await require('../utils/vintageProfile').ensurePendingVintageProfile(wineId, bottle.vintage);
    } catch { /* bookkeeping only */ }
    if (!req?.user?.isDemo) {
      require('./embeddingJob').embedSinglePair(wineId, bottle.vintage).catch(() => {});
    }
  }
  return { bottle };
}

/**
 * "Change wine": the bottle was saved under the wrong registry wine (a red
 * filed under the estate's white, a twin picked from the search). It moves to
 * `wineDoc` and keeps everything that is the owner's own: dates, price,
 * notes, rating, rack slot, journey, personal data and barcode (which from
 * now on counts for the right wine). Before this existed the only way out was
 * remove + add again, which lost all of that.
 *
 * Also: the bottle's own photos follow it (an official registry picture of
 * the old wine stays put: that is curation); a bottle still waiting on an
 * import wine request leaves the request, which is withdrawn when no bottle
 * waits on it any more; the new vintage is queued for a drink window (not
 * for a bottle on order — it is queued when it arrives) and embedded.
 *
 * `wineDoc` must already be visibility-checked by the caller
 * (services/wineVisibility.findVisibleWine). Mirrors POST /api/bottles/:id/change-wine.
 * Returns { error } | { bottle, from }.
 */
async function changeBottleWine(bottle, wineDoc, req) {
  const fromId = bottle.wineDefinition ? String(bottle.wineDefinition._id || bottle.wineDefinition) : null;
  if (fromId && fromId === String(wineDoc._id)) {
    return { error: { status: 400, code: 'same_wine', message: 'The bottle is already this wine' } };
  }
  let fromName = null;
  if (fromId) {
    const WineDefinition = require('../models/WineDefinition');
    const from = await WineDefinition.findById(fromId).select('producer name').lean();
    fromName = from ? [from.producer, from.name].filter(Boolean).join(' — ') : null;
  }
  const pendingRequestId = bottle.pendingWineRequest || null;

  bottle.wineDefinition = wineDoc._id;
  bottle.pendingWineRequest = undefined;
  try {
    await bottle.save();
  } catch (err) {
    if (err?.name === 'VersionError') return { error: { status: 409, message: 'This bottle was modified by another request. Please refresh and try again.' } };
    if (err?.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    throw err;
  }

  // The bottle's own photos show this bottle, so they follow it. An image the
  // old wine uses as its official picture stays: that is a registry decision.
  await BottleImage.updateMany(
    { bottle: bottle._id, assignedToWine: { $ne: true } },
    { $set: { wineDefinition: wineDoc._id } }
  );

  // Same rule as removeBottleCascade: one import request covers every bottle
  // of that wine, so it goes only when THIS was the last bottle waiting on it.
  if (pendingRequestId) {
    const stillWaiting = await Bottle.countDocuments({ pendingWineRequest: pendingRequestId });
    if (stillWaiting === 0) {
      await WineRequest.deleteOne({ _id: pendingRequestId, status: 'pending' });
    }
  }

  logAudit(req, 'bottle.change_wine',
    { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
    { fromWineId: fromId, fromWine: fromName, toWineId: String(wineDoc._id), toWine: [wineDoc.producer, wineDoc.name].filter(Boolean).join(' — '), vintage: bottle.vintage });

  // Bookkeeping for the new (wine, vintage): never fails the change.
  if (bottle.status !== ORDERED_STATUS) {
    try {
      await require('../utils/vintageProfile').ensurePendingVintageProfile(wineDoc._id, bottle.vintage);
    } catch { /* bookkeeping only */ }
  }
  if (!req?.user?.isDemo) {
    require('./embeddingJob').embedSinglePair(wineDoc._id, bottle.vintage).catch(() => {});
  }
  if (wineDoc.draft === true) {
    try { await require('./wineDraftOps').touchDraft(wineDoc._id); } catch { /* never fails the change */ }
  }
  return { bottle, from: fromId };
}

module.exports = {
  consumeBottle, restoreBottle, removeFromRacks, RESTORE_WINDOW_MS,
  markArrived, parseOnOrderFields, NOT_ARRIVED_ERROR, changeBottleWine,
  addBottle, validateBottleCommitFields, updateBottleFields, removeBottleCascade, UPDATABLE_FIELDS,
  snapshotBottleForDelete, restoreDeletedBottle,
  openBottle, pourFromBottle, closeBottle,
  PRESERVATION_METHODS, DEFAULT_POUR_ML, MAX_POURS,
};
