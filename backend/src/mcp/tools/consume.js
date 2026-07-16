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
      // Rows created BY an undo are never candidates: sequential undos walk
      // BACKWARD through the user's own actions ("undo, undo" = revert the
      // update, then the add) — they must not ping-pong on one action.
      viaUndo: { $ne: true },
      // Reversing add/update needs the write grant — a consume-only token
      // must never gain delete-a-bottle power through undo.
      action: {
        $in: (ctx.scopes || []).includes('write')
          ? ['consume', 'restore', 'add', 'update', 'bulk_add', 'somm_maturity', 'somm_price']
          : ['consume', 'restore'],
      },
      createdAt: { $gte: new Date(Date.now() - RESTORE_WINDOW_MS) },
    }).sort({ createdAt: -1 });
    if (!last) return fail('not_found', 'No recent MCP action to undo — nothing has been changed through MCP in the last few days.');

    // Somm curation rows reference registry data, not a bottle — handled first.
    // The role is re-checked: a somm demoted since the action cannot keep
    // rewriting shared data through undo.
    if (last.action === 'somm_maturity' || last.action === 'somm_price') {
      const roles = ctx.user?.roles || [];
      if (!roles.includes('somm') && !roles.includes('admin')) {
        return fail('forbidden_scope', 'Undoing sommelier curation needs the sommelier (or admin) role.');
      }
      // Load the maturity target BEFORE claiming the row, so a deleted
      // profile leaves the ledger row un-consumed (retryable) instead of
      // burning it on a no-op.
      let profile = null;
      if (last.action === 'somm_maturity') {
        const WineVintageProfile = require('../../models/WineVintageProfile');
        profile = await WineVintageProfile.findById(last.detail?.profileId);
        if (!profile) return fail('conflict', 'That maturity profile no longer exists; nothing was changed.');
      }
      const claimed = await McpActionLog.findOneAndUpdate(
        { _id: last._id, reversed: false },
        { $set: { reversed: true, idempotencyKey: null } }
      );
      if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

      let sommEnvelope;
      if (last.action === 'somm_price') {
        const WineVintagePrice = require('../../models/WineVintagePrice');
        const del = await WineVintagePrice.deleteOne({ _id: last.detail?.entryId, setBy: ctx.user.id });
        sommEnvelope = {
          summary: del.deletedCount
            ? `Undid price entry — snapshot for vintage ${last.detail?.vintage} removed`
            : 'Price snapshot was already gone; ledger marked undone.',
          data: { undone: 'set_vintage_price', removed: !!del.deletedCount },
        };
      } else {
        const prev = last.prev || {};
        for (const f of ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil']) {
          profile[f] = prev[f] === null || prev[f] === undefined ? undefined : prev[f];
        }
        profile.sommNotes = prev.sommNotes === null ? undefined : prev.sommNotes;
        profile.status = prev.status || 'pending';
        profile.relative = !!prev.relative;
        profile.setBy = prev.setBy || null;
        profile.setAt = prev.setAt || null;
        await profile.save();
        sommEnvelope = {
          summary: `Undid maturity review — vintage ${last.detail?.vintage} back to ${profile.status}`,
          data: { undone: 'set_vintage_maturity', profile_id: String(profile._id), status: profile.status },
        };
      }
      await logAction(ctx, {
        tool: 'undo_last',
        action: last.action,
        viaUndo: true,
        detail: { undid: String(last._id) },
        result: sommEnvelope,
      });
      return ok(sommEnvelope.summary, sommEnvelope.data);
    }

    // Bulk rows reference MANY bottles (detail.bottles), no single last.bottle
    // — handled before the single-bottle access resolution below.
    if (last.action === 'bulk_add') {
      const { removeBottleCascade } = require('../../services/bottleOps');
      const ids = last.detail?.bottles || [];
      if (!ids.length) return fail('conflict', 'That bulk add recorded no bottles; nothing to undo.');
      // All-or-nothing: verify access + active status for EVERY bottle first,
      // so a batch undo can never half-delete.
      const resolved = [];
      for (const id of ids) {
        const a = await resolveBottleAccess(ctx.user.id, id, 'editor');
        if (!a) return fail('conflict', `Bottle ${id} from that batch is no longer accessible; nothing was changed.`);
        if (a.bottle.status !== 'active') {
          return fail('conflict', `Bottle ${id} from that batch has been ${a.bottle.status} since; undo it individually or restore it first. Nothing was changed.`);
        }
        resolved.push(a.bottle);
      }
      // Claim the row atomically BEFORE cascading (plain save has no
      // concurrency guard on this model), so a crash or failure mid-cascade
      // can never leave a half-deleted batch that blocks undo_last for days —
      // the outcome, including any per-bottle failures, is reported honestly.
      const claimed = await McpActionLog.findOneAndUpdate(
        { _id: last._id, reversed: false },
        { $set: { reversed: true, idempotencyKey: null } }
      );
      if (!claimed) return fail('conflict', 'That batch is already being undone by another request.');
      const removed = [];
      const failures = [];
      for (const b of resolved) {
        try {
          const r = await removeBottleCascade(b, ctx.req, 'bottle.undo');
          if (r.error) failures.push({ bottle_id: String(b._id), error: r.error.message });
          else removed.push(String(b._id));
        } catch (err) {
          failures.push({ bottle_id: String(b._id), error: err.message });
        }
      }
      const bulkEnvelope = {
        summary: `Undid bulk add — ${removed.length} bottle(s) removed${failures.length ? `, ${failures.length} FAILED (remove those manually)` : ''}`,
        data: { undone: 'bulk_add', removed_bottle_ids: removed, ...(failures.length ? { failures } : {}) },
      };
      await logAction(ctx, {
        tool: 'undo_last',
        action: 'undo_add',
        viaUndo: true,
        cellar: last.cellar,
        detail: { undid: String(last._id), count: resolved.length },
        result: bulkEnvelope,
      });
      return ok(bulkEnvelope.summary, bulkEnvelope.data);
    }

    const access = await resolveBottleAccess(ctx.user.id, last.bottle, 'editor');
    if (!access) return fail('conflict', 'The bottle from the last action is no longer accessible; nothing was changed.');
    const { bottle } = access;

    let envelope;
    let reverseEntry;
    if (last.action === 'add') {
      // Undo an add = remove the bottle again (the REST /undo cascade: rack
      // slots, search, images, pending wine request, then the doc). Only an
      // ACTIVE bottle — if it was consumed/changed since, refuse.
      const { removeBottleCascade } = require('../../services/bottleOps');
      const result = await removeBottleCascade(bottle, ctx.req, 'bottle.undo');
      if (result.error) {
        return fail('conflict', `Cannot undo that add: ${result.error.message} Nothing was changed.`);
      }
      envelope = {
        summary: `Undid add — ${bottleLabel(bottle)} removed from the cellar`,
        data: { undone: 'add_bottle', bottle_id: bottle._id },
      };
      reverseEntry = { action: 'undo_add', prev: null };
    } else if (last.action === 'update') {
      // Undo an update = re-apply the snapshotted previous values.
      const { updateBottleFields } = require('../../services/bottleOps');
      const prevFields = last.prev || {};
      if (Object.keys(prevFields).length === 0) {
        return fail('conflict', 'That update has no recorded previous values; nothing was changed.');
      }
      const result = await updateBottleFields(bottle, prevFields, ctx.req);
      if (result.error) return fail('conflict', `Cannot undo that update: ${result.error.message}`);
      envelope = {
        summary: `Undid update on ${bottleLabel(bottle)} — restored: ${Object.keys(prevFields).join(', ')}`,
        data: { undone: 'update_bottle', bottle_id: bottle._id, restored: result.changes },
      };
      // The reverse row snapshots what we just overwrote, so undo-of-undo works.
      reverseEntry = { action: 'update', prev: result.prev };
    } else if (last.action === 'consume') {
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
    // Free the idempotency key: a retry after an undo must re-execute AND get
    // a fresh ledger row (the unique index would otherwise swallow it).
    last.idempotencyKey = null;
    await last.save();
    await logAction(ctx, {
      tool: 'undo_last',
      ...reverseEntry,
      viaUndo: true,
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { undid: String(last._id) },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
