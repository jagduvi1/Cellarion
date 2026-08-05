// The first MUTATING MCP tools (plan §5.7 write-safety ships WITH them):
// consume_bottle / restore_bottle / undo_last, scope `consume` — the same
// scope the Home Assistant integration already uses for its consume button.
//
// Write-safety layers active here:
//  - L1 structural: only `consume`-scoped callers ever see these tools; the
//    worst outcome is a reversible soft status change (no deletes exist).
//  - L2 client confirmation: destructiveHint + concrete summaries let clients
//    prompt "consume the 2015 Barolo?" before executing.
//  - L3 server checks: editor-level access re-verified per call, an already-
//    consumed bottle is a conflict (a looping agent can't double-log), and an
//    optional idempotency_key replays the ORIGINAL result instead of re-acting.
//  - L4 reversibility + ledger: every action lands in McpActionLog (undo_last,
//    the future activity timeline) and in the normal audit log (which also
//    emits the stats_changed SSE nudge the HA integration listens to).
//
// bottleOps is the SAME implementation the REST routes run — validation, rack
// freeing, re-indexing, audit and restock checks cannot drift between surfaces.
const { z } = require('zod');
const Bottle = require('../../models/Bottle');
const { CONSUMED_STATUSES } = require('../../config/constants');
const { registerTool } = require('../registry');
const { consumeBottle, restoreBottle, RESTORE_WINDOW_MS } = require('../../services/bottleOps');
const { isReserved, reservationLabel } = require('../../utils/reservationUtils');
const { logAction, replay } = require('../actionLedger');
const { ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');

const RESTORE_WINDOW_DAYS = Math.round(RESTORE_WINDOW_MS / 86400000);

function bottleLabel(bottle) {
  return `bottle ${bottle._id} (vintage ${bottle.vintage})`;
}

registerTool({
  name: 'consume_bottle',
  title: 'Consume a bottle (drank / gifted / sold)',
  description:
    'Marks one bottle as consumed: drank (default), gifted, sold or other, with an optional note and rating. ' +
    'Frees its rack slot. ALWAYS confirm with the user first, naming the exact wine and vintage — this changes their ' +
    `cellar. Reversible for ${RESTORE_WINDOW_DAYS} days via restore_bottle / undo_last. ` +
    'A RESERVED ("spoken for") bottle is refused until you confirm the reservation with the user and retry with ' +
    'acknowledge_reservation:true. Pass an idempotency_key when retrying so the action can never run twice.',
  scope: 'consume',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.describe('Bottle id from search_bottles'),
    reason: z.enum(CONSUMED_STATUSES).default('drank'),
    note: z.string().max(1000).optional().describe('Tasting note / occasion'),
    rating: z.number().min(0).max(100).optional(),
    rating_scale: z.enum(['5', '20', '100']).optional().describe('Scale the rating is on (required with rating)'),
    acknowledge_reservation: z.boolean().optional()
      .describe('Required true to consume a reserved ("spoken for") bottle — only after the user explicitly confirmed'),
    idempotency_key: z.string().max(100).optional().describe('Unique key: a retry with the same key returns the original result'),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'consume_bottle');
    if (replayed) return replayed;

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    // Guard a retrying/confused agent: consuming twice would silently
    // overwrite the original consumption record.
    if (CONSUMED_STATUSES.includes(bottle.status)) {
      return fail('conflict',
        `This bottle was already consumed (${bottle.consumedReason || bottle.status}${bottle.consumedAt ? ` on ${bottle.consumedAt.toISOString().slice(0, 10)}` : ''}). ` +
        'Use restore_bottle first if that was a mistake, or check you have the right bottle_id.');
    }

    // Reservation guard: a "spoken for" bottle needs explicit acknowledgment
    // (mirrors the web consume flow's reservation confirm). Same conflict
    // shape as the already-consumed guard — the agent must go back to the
    // user, then retry with acknowledge_reservation:true.
    if (isReserved(bottle) && !args.acknowledge_reservation) {
      return fail('conflict',
        `This bottle is ${reservationLabel(bottle)}. Confirm with the user that they really want to consume it ` +
        '(and whether to clear the reservation), then retry with acknowledge_reservation:true.');
    }

    const result = await consumeBottle(bottle, {
      reason: args.reason || 'drank',
      note: args.note,
      rating: args.rating,
      ratingScale: args.rating_scale,
    }, ctx.req);
    if (result.error) return fail('invalid_input', result.error.message);

    const data = {
      bottle_id: bottle._id,
      status: bottle.status,
      consumed_at: bottle.consumedAt,
      undo: `restore_bottle with this bottle_id (or undo_last) within ${RESTORE_WINDOW_DAYS} days`,
    };
    const envelope = { summary: `Consumed ${bottleLabel(bottle)}: ${bottle.status}`, data };
    await logAction(ctx, {
      tool: 'consume_bottle',
      action: 'consume',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { reason: bottle.status },
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'restore_bottle',
  title: 'Restore a consumed bottle',
  description:
    'Puts a recently-consumed bottle back into the cellar (undo an accidental consume). Only works within ' +
    `${RESTORE_WINDOW_DAYS} days of consumption; the bottle returns UNPLACED (its old rack slot may be taken). ` +
    'Find candidates via list_history.',
  scope: 'consume',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { bottle_id: objectId.describe('Bottle id from list_history') },
  handler: async (args, ctx) => {
    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    // Snapshot BEFORE the restore clears the fields — undoing a restore means
    // re-consuming with exactly these values.
    const prev = {
      reason: bottle.consumedReason || bottle.status,
      note: bottle.consumedNote,
      rating: bottle.consumedRating,
      ratingScale: bottle.consumedRatingScale,
    };
    const result = await restoreBottle(bottle, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'restore_window_expired' ? 'conflict' : 'invalid_input', result.error.message);
    }

    const envelope = {
      summary: `Restored ${bottleLabel(bottle)} to the cellar (was ${result.from})`,
      data: { bottle_id: bottle._id, status: 'active', was: result.from, placement: null },
    };
    await logAction(ctx, {
      tool: 'restore_bottle',
      action: 'restore',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { from: result.from },
      prev,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'undo_last',
  title: 'Undo the last MCP cellar change on this account',
  description:
    'Reverses the account\'s most recent un-reversed MCP action (any MCP connection, not UI changes): an accidental ' +
    'consume_bottle becomes a restore; an accidental restore_bottle re-consumes with the original reason/note/rating. ' +
    `Only actions from the last ${RESTORE_WINDOW_DAYS} days are undoable, and only if the bottle hasn't been changed ` +
    'since. Call when the user says "undo that" about a change YOU just made. Tell the user exactly what was undone.',
  // Reachable by a consume OR a write token — it reverses both kinds of
  // mutation, and the write tools all promise "reversible via undo_last".
  scope: ['consume', 'write'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {},
  handler: async (_args, ctx) => {
    // The reversal engine (shared with the in-app activity timeline) finds the
    // caller's newest reversible action and reverses it. All the per-action
    // logic — access re-checks, atomic claims, prev-snapshot restores, the
    // consume-vs-write scope gate, the recency window — lives in mcp/revert.js.
    const { revertLatest } = require('../revert');
    return revertLatest(ctx, { ok, fail });
  },
});
