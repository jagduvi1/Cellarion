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
const McpActionLog = require('../../models/McpActionLog');
const { CONSUMED_STATUSES } = require('../../config/constants');
const { registerTool } = require('../registry');
const { consumeBottle, restoreBottle, RESTORE_WINDOW_MS } = require('../../services/bottleOps');
const { ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');

const RESTORE_WINDOW_DAYS = Math.round(RESTORE_WINDOW_MS / 86400000);

function bottleLabel(bottle) {
  return `bottle ${bottle._id} (vintage ${bottle.vintage})`;
}

/** Persist the action ledger row. Never throws (the action itself succeeded). */
async function logAction(ctx, entry) {
  try {
    return await McpActionLog.create({
      user: ctx.user.id,
      tokenId: ctx.req?.apiToken?.id || null,
      ...entry,
    });
  } catch (err) {
    // Duplicate idempotencyKey race: the concurrent twin already recorded it.
    if (err?.code !== 11000) console.error('[mcp] action log failed:', err.message);
    return null;
  }
}

/**
 * Idempotent replay: return the stored envelope for a seen key, else null.
 * Reversed actions don't replay — if the action was undone since, a retry
 * should go through the normal path (and re-assert) rather than reporting a
 * stale success for a state that no longer holds.
 */
async function replay(ctx, idempotencyKey) {
  if (!idempotencyKey) return null;
  const seen = await McpActionLog.findOne({ user: ctx.user.id, idempotencyKey, reversed: false }).lean();
  return seen?.result ? { content: [{ type: 'text', text: JSON.stringify(seen.result) }] } : null;
}

registerTool({
  name: 'consume_bottle',
  title: 'Consume a bottle (drank / gifted / sold)',
  description:
    'Marks one bottle as consumed: drank (default), gifted, sold or other, with an optional note and rating. ' +
    'Frees its rack slot. ALWAYS confirm with the user first, naming the exact wine and vintage — this changes their ' +
    `cellar. Reversible for ${RESTORE_WINDOW_DAYS} days via restore_bottle / undo_last. ` +
    'Pass an idempotency_key when retrying so the action can never run twice.',
  scope: 'consume',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.describe('Bottle id from search_bottles'),
    reason: z.enum(CONSUMED_STATUSES).default('drank'),
    note: z.string().max(1000).optional().describe('Tasting note / occasion'),
    rating: z.number().min(0).max(100).optional(),
    rating_scale: z.enum(['5', '20', '100']).optional().describe('Scale the rating is on (required with rating)'),
    idempotency_key: z.string().max(100).optional().describe('Unique key: a retry with the same key returns the original result'),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key);
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
  scope: 'consume',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {},
  handler: async (_args, ctx) => {
    // Recency bound mirrors the restore window: an action too old to reverse
    // cleanly is also too old to be "the thing the user just did".
    const last = await McpActionLog.findOne({
      user: ctx.user.id,
      reversed: false,
      action: { $in: ['consume', 'restore'] },
      createdAt: { $gte: new Date(Date.now() - RESTORE_WINDOW_MS) },
    }).sort({ createdAt: -1 });
    if (!last) return fail('not_found', 'No recent MCP action to undo — nothing has been changed through MCP in the last few days.');

    const access = await resolveBottleAccess(ctx.user.id, last.bottle, 'editor');
    if (!access) return fail('conflict', 'The bottle from the last action is no longer accessible; nothing was changed.');
    const { bottle } = access;

    let envelope;
    let reverseEntry;
    if (last.action === 'consume') {
      // Snapshot BEFORE restoring, so undoing THIS undo can re-consume with
      // the original values instead of defaults.
      const prevSnapshot = {
        reason: bottle.consumedReason || bottle.status,
        note: bottle.consumedNote,
        rating: bottle.consumedRating,
        ratingScale: bottle.consumedRatingScale,
      };
      const result = await restoreBottle(bottle, ctx.req);
      if (result.error) return fail('conflict', `Cannot undo that consume: ${result.error.message}`);
      envelope = {
        summary: `Undid consume — ${bottleLabel(bottle)} is back in the cellar (unplaced)`,
        data: { undone: 'consume_bottle', bottle_id: bottle._id, status: 'active' },
      };
      reverseEntry = { action: 'restore', prev: prevSnapshot };
    } else {
      // The bottle's state may have moved on since that restore (e.g. the user
      // re-consumed it in the web app — UI actions never enter this ledger).
      // Re-consuming would silently overwrite the newer record: refuse.
      if (CONSUMED_STATUSES.includes(bottle.status)) {
        return fail('conflict',
          'That restore cannot be undone: the bottle has been consumed again since (possibly in the web app). Nothing was changed.');
      }
      const prev = last.prev || {};
      const result = await consumeBottle(bottle, {
        reason: prev.reason || 'drank',
        note: prev.note,
        rating: prev.rating,
        ratingScale: prev.ratingScale,
      }, ctx.req);
      if (result.error) return fail('conflict', `Cannot undo that restore: ${result.error.message}`);
      envelope = {
        summary: `Undid restore — ${bottleLabel(bottle)} is consumed again (${bottle.status})`,
        data: { undone: 'restore_bottle', bottle_id: bottle._id, status: bottle.status },
      };
      reverseEntry = { action: 'consume', prev: null };
    }

    last.reversed = true;
    await last.save();
    await logAction(ctx, {
      tool: 'undo_last',
      ...reverseEntry,
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { undid: String(last._id) },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
