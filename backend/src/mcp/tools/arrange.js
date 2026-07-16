// auto_arrange (plan Phase 3) — server-side auto-arrange for one rack, using
// the SAME decision engine as the web app's Arrange modal (utils/rackArrange,
// the backend twin of frontend/src/utils/rackArrange.js) under the bulk-style
// preview → apply write-safety contract:
//
//   1. mode:'preview' (default) — computes the plan from the CURRENT rack
//      state and stores it server-side; nothing changes. The model must show
//      the move list to the user.
//   2. mode:'apply' { preview_id } — re-checks that the rack still matches the
//      previewed state exactly (any slot change since = conflict), charges the
//      mutation budget one slot PER MOVED BOTTLE (the same cost the web app's
//      per-move calls would pay), then applies the whole target assignment in
//      ONE atomic rack save — no partial arrangements, ever.
//
// The applied arrangement is one ledger row → one undo_last / one in-app
// revert restores the exact previous layout (mcp/structuralUndo.js).
const { z } = require('zod');
const Rack = require('../../models/Rack');
const McpActionLog = require('../../models/McpActionLog');
const { registerTool } = require('../registry');
const { getMaxPosition } = require('../../utils/rackGeometry');
const { ARRANGE_STRATEGIES, buildArrangePlan } = require('../../utils/rackArrange');
// Maturity annotation + the one-save atomic apply live in services/rackOps —
// shared with a future REST arrange endpoint (one-impl rule).
const { buildAnnotatedEntries, applyArrangement } = require('../../services/rackOps');
const { isValidId } = require('../../utils/validation');
const { ok, fail, objectId, resolveCellarAccess } = require('../toolUtil');
const { logAction } = require('../actionLedger');
const { takeMutationSlot } = require('../mutationBudget');

const PREVIEW_FRESH_MS = 15 * 60 * 1000;
const NOT_FOUND = 'No such rack, or you have no access to it. Use list_racks for valid ids.';

/** Load a rack with populated slot bottles + confirm the caller can edit it. */
async function loadRackForArrange(userId, rackId) {
  if (!isValidId(String(rackId))) return null;
  const stub = await Rack.findOne({ _id: rackId, deletedAt: null }).select('cellar').lean();
  if (!stub) return null;
  const access = await resolveCellarAccess(userId, stub.cellar, 'editor');
  if (!access) return null;
  const rack = await Rack.findOne({ _id: rackId, deletedAt: null }).populate({
    path: 'slots.bottle',
    select: 'vintage status drinkFrom drinkTo wineDefinition',
    populate: { path: 'wineDefinition', select: 'name producer type' },
  });
  if (!rack) return null;
  return { rack, cellar: access.cellar };
}

/** Current occupancy as sorted [{position, bottleId}] for exact comparison. */
function occupancyOf(rack) {
  return (rack.slots || [])
    .filter((s) => s.bottle)
    .map((s) => ({ position: s.position, bottleId: String(s.bottle._id || s.bottle) }))
    .sort((a, b) => a.position - b.position);
}

const sameOccupancy = (a, b) =>
  a.length === b.length && a.every((x, i) => x.position === b[i].position && x.bottleId === b[i].bottleId);

const labelOf = (bottle) => {
  const wd = bottle?.wineDefinition;
  return `${bottle?.vintage || '?'} ${wd?.name || 'Unknown wine'}${wd?.producer ? ` (${wd.producer})` : ''}`;
};

registerTool({
  name: 'auto_arrange',
  title: 'Auto-arrange a rack (preview, then apply)',
  description:
    'Reorders one rack\'s bottles by a strategy — "maturity" puts drink-soonest bottles in the first (top-left, most ' +
    'accessible) slots, "type" groups by style, "vintage" sorts chronologically. TWO steps: preview computes the move ' +
    'list without changing anything — SHOW IT TO THE USER; apply (with the preview_id, after their approval) updates ' +
    'the whole rack atomically. The returned move list is the user\'s guide for physically re-shelving. One undo_last ' +
    'restores the previous layout. Zones and disabled slots are respected as holes; zone GROUPING is web-app-only.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    mode: z.enum(['preview', 'apply']).default('preview'),
    rack_id: objectId.optional().describe('Required for preview'),
    strategy: z.enum(ARRANGE_STRATEGIES).default('maturity').describe('Preview only: how to order the bottles'),
    preview_id: z.string().optional().describe('Required for apply — from the preview response'),
  },
  handler: async (args, ctx) => {
    if ((args.mode || 'preview') === 'preview') {
      if (!args.rack_id) return fail('invalid_input', 'preview needs rack_id (from list_racks)');
      const loaded = await loadRackForArrange(ctx.user.id, args.rack_id);
      if (!loaded) return fail('not_found', NOT_FOUND);
      const { rack } = loaded;
      const strategy = args.strategy || 'maturity';

      // Same classification the rack views color by (routes/racks withMaturity).
      const entries = await buildAnnotatedEntries(rack);
      if (entries.length === 0) return ok('Rack is empty — nothing to arrange', { changes: [] });

      const { target, changes } = buildArrangePlan(entries, getMaxPosition(rack), rack.disabledPositions || [], strategy);
      if (changes.length === 0) {
        return ok(`Rack "${rack.name}" is already arranged by ${strategy} — nothing to move`, { changes: [] });
      }

      const before = occupancyOf(rack);
      const moveList = changes.map((c) => ({ bottle: labelOf(c.bottle), from: c.from, to: c.to }));
      const row = await McpActionLog.create({
        user: ctx.user.id,
        tokenId: ctx.req?.apiToken?.id || null,
        tool: 'auto_arrange',
        action: 'arrange_preview',
        cellar: rack.cellar,
        detail: { rackId: String(rack._id), strategy, moves: changes.length },
        // Apply re-reads everything from here — the client cannot swap the plan.
        prev: { rackId: String(rack._id), strategy, before, target, moveList },
        result: null,
      });
      return ok(
        `Preview: ${changes.length} of ${entries.length} bottle(s) would move (strategy: ${strategy})`,
        {
          preview_id: String(row._id),
          rack: rack.name,
          strategy,
          bottles_moving: changes.length,
          bottles_total: entries.length,
          moves: moveList,
          guidance: 'Show this move list to the user. On their approval call auto_arrange with mode:"apply" and this preview_id.',
        }
      );
    }

    // ── apply ──
    if (!args.preview_id || !isValidId(args.preview_id)) {
      return fail('invalid_input', 'apply needs the preview_id from a fresh preview');
    }
    const preview = await McpActionLog.findOne({
      _id: args.preview_id,
      user: ctx.user.id,
      action: 'arrange_preview',
      reversed: false,
    });
    if (!preview) return fail('not_found', 'No such (unused) arrange preview — run a fresh preview.');
    if (Date.now() - preview.createdAt.getTime() > PREVIEW_FRESH_MS) {
      return fail('conflict', 'That preview has expired (15 min) — run a fresh preview.');
    }
    const { rackId, strategy, before, target, moveList } = preview.prev || {};
    if (!rackId || !Array.isArray(before) || !Array.isArray(target)) {
      return fail('conflict', 'That preview is incomplete — run a fresh preview.');
    }
    const loaded = await loadRackForArrange(ctx.user.id, rackId);
    if (!loaded) return fail('not_found', NOT_FOUND);
    const { rack } = loaded;

    // The rack must still be EXACTLY as previewed — any placement, removal or
    // move since makes the stored plan stale (it could drop a new bottle).
    if (!sameOccupancy(occupancyOf(rack), before)) {
      return fail('conflict', 'The rack has changed since the preview — run a fresh preview.');
    }

    const moved = moveList?.length || target.length;
    if (!takeMutationSlot(String(ctx.user.id), moved)) {
      return fail('rate_limited', `Not enough write budget left to move ${moved} bottle(s) this window — wait a few minutes.`);
    }

    // Single-use claim (same pattern as bulk_add): exactly one concurrent
    // apply wins. prev is cleared — the applied row below carries the undo data.
    const claimed = await McpActionLog.findOneAndUpdate(
      { _id: preview._id, reversed: false },
      { $set: { reversed: true, prev: null } }
    );
    if (!claimed) return fail('conflict', 'That preview was just used by another request.');

    // One atomic save via the shared rackOps.applyArrangement — the whole
    // target assignment at once; optimistic concurrency turns a concurrent
    // slot write into a clean conflict instead of a lost update.
    const applied = await applyArrangement(rack, target, ctx.req, { via: 'mcp', strategy, moved });
    if (applied.error) {
      return fail('conflict', `${applied.error.message} Run a fresh preview.`);
    }

    const envelope = {
      summary: `Arranged rack "${rack.name}" by ${strategy} — ${moved} bottle(s) moved`,
      data: {
        rack_id: rack._id,
        strategy,
        moved,
        moves: moveList || [],
        physical_guide: 'The moves list is the user\'s guide for re-shelving the physical bottles.',
        undo: 'undo_last (or the in-app revert) restores the previous layout',
      },
    };
    await logAction(ctx, {
      tool: 'auto_arrange',
      action: 'arrange',
      cellar: rack.cellar,
      detail: { rackId: String(rack._id), strategy, moved, target },
      prev: { before },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
