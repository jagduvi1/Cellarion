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
const { stripHtml } = require('../utils/sanitize');
const { logAudit } = require('./audit');
const Rack = require('../models/Rack');

// Restores are "undo an accidental log", not resurrection of a bottle drunk
// long ago (see the /restore route docs). Shared so REST and MCP agree.
const RESTORE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

/** Free any rack slot holding this bottle (consume/delete paths). */
async function removeFromRacks(bottleId) {
  await Rack.updateMany(
    { 'slots.bottle': bottleId },
    { $pull: { slots: { bottle: bottleId } } }
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

module.exports = { consumeBottle, restoreBottle, removeFromRacks, RESTORE_WINDOW_MS };
