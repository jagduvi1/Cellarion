// Cellar / rack / placement write tools (plan Phase 2c). Grid racks only in
// v1 (modular racks, zones, disabled-slot management, auto-arrange deferred).
// All mutations run through services/rackOps — the SAME code the REST routes
// use, so the procedural one-bottle-per-slot invariant and the move ordering
// can't drift between surfaces.
const { z } = require('zod');
const Rack = require('../../models/Rack');
const Cellar = require('../../models/Cellar');
const Bottle = require('../../models/Bottle');
const { registerTool } = require('../registry');
const {
  createCellar, createGridRack, placeBottleInRack, clearRackSlot, moveBottleToCellar,
} = require('../../services/rackOps');
const {
  ok, fail, objectId, MSG_CELLAR_NOT_FOUND, MSG_BOTTLE_NOT_FOUND,
  resolveCellarAccess, resolveBottleAccess,
} = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');

// Load a rack + confirm the caller can edit its cellar. Returns { rack, cellar }
// or null (missing/foreign → not_found, same as the rest of the surface).
async function resolveRackAccess(userId, rackId, minRole = 'editor') {
  const rack = await Rack.findOne({ _id: rackId, deletedAt: null });
  if (!rack) return null;
  const access = await resolveCellarAccess(userId, rack.cellar, minRole);
  if (!access) return null;
  return { rack, cellar: access.cellar };
}

registerTool({
  name: 'create_cellar',
  title: 'Create a new cellar',
  description:
    'Creates an empty cellar owned by the user. Confirm the name first. Reversible via undo_last only while it is ' +
    'still empty.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'create_cellar');
    if (replayed) return replayed;
    const result = await createCellar({ name: args.name, description: args.description }, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'duplicate' ? 'conflict' : 'invalid_input', result.error.message);
    }
    const envelope = {
      summary: `Created cellar "${result.cellar.name}"`,
      data: { cellar_id: result.cellar._id, name: result.cellar.name, undo: 'undo_last deletes it while still empty' },
    };
    await logAction(ctx, {
      tool: 'create_cellar', action: 'cellar_create', cellar: result.cellar._id,
      detail: { name: result.cellar.name }, idempotencyKey: args.idempotency_key || null, result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'create_rack',
  title: 'Create a rack or wine cabinet in a cellar',
  description:
    'Adds a rack to a cellar the user owns or edits. type "grid" (default): rows × cols slots. type "cabinet": a wine ' +
    'fridge — rows = shelves, cols = bottles across, shelf_rows = rows of bottles each shelf holds top to bottom ' +
    '(1 = a sliding shelf with one row, more = a stacking bay; one entry per shelf), two_deep = bottles lie neck to ' +
    'neck two rows deep (default true). Confirm name and shape first; group is the optional room or appliance label ' +
    'the rack belongs to ("Basement", "Kitchen fridge") — reuse a group name list_racks already shows so racks ' +
    'section together. For other rack shapes, modular racks, zones or disabled slots, use the web app. Reversible ' +
    'via undo_last while the rack is still empty.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    cellar_id: objectId,
    name: z.string().min(1).max(120),
    type: z.enum(['grid', 'cabinet']).default('grid').describe('"grid" = rows × cols slots; "cabinet" = a wine fridge with shelves (see shelf_rows)'),
    rows: z.number().int().min(1).max(20).default(4).describe('Rows of slots (grid) or number of shelves (cabinet)'),
    cols: z.number().int().min(1).max(20).default(8).describe('Slots per row (grid) or bottles across one row (cabinet)'),
    shelf_rows: z.array(z.number().int().min(1).max(12)).min(1).max(20).optional()
      .describe('Cabinet only: rows of bottles per shelf, top shelf first, one entry per shelf (must equal rows). Required for type "cabinet".'),
    two_deep: z.boolean().optional().describe('Cabinet only: bottles lie neck to neck, two rows deep per level (default true)'),
    stagger: z.boolean().optional().describe('Cabinet only: stacked rows nest in the grooves of the row below, offset half a bottle (default true). Drawing only — capacity is unchanged.'),
    group: z.string().max(40).optional().describe('Optional group label (room or appliance), e.g. "Basement"'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'create_rack');
    if (replayed) return replayed;
    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id, 'editor');
    if (!access) return fail('not_found', MSG_CELLAR_NOT_FOUND);
    const type = args.type || 'grid';
    let typeConfig;
    if (type === 'cabinet') {
      if (!Array.isArray(args.shelf_rows)) {
        return fail('invalid_input', 'shelf_rows is required for a cabinet: one entry per shelf, rows of bottles each shelf holds (top shelf first)');
      }
      typeConfig = { shelfRows: args.shelf_rows, twoDeep: args.two_deep !== false, stagger: args.stagger !== false };
    } else if (args.shelf_rows !== undefined || args.two_deep !== undefined || args.stagger !== undefined) {
      return fail('invalid_input', 'shelf_rows, two_deep and stagger apply to type "cabinet" only');
    }
    const result = await createGridRack(access.cellar, { name: args.name, type, rows: args.rows, cols: args.cols, typeConfig, group: args.group }, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'duplicate' ? 'conflict' : 'invalid_input', result.error.message);
    }
    const capacity = type === 'cabinet' ? args.shelf_rows.reduce((sum, r) => sum + r * args.cols, 0) : args.rows * args.cols;
    const envelope = {
      summary: type === 'cabinet'
        ? `Created wine cabinet "${result.rack.name}" in "${access.cellar.name}": ${args.rows} shelves, ${args.cols} across, ${capacity} bottles`
        : `Created ${args.rows}×${args.cols} rack "${result.rack.name}" in "${access.cellar.name}"`,
      data: {
        rack_id: result.rack._id, cellar_id: access.cellar._id, type, rows: args.rows, cols: args.cols, capacity,
        ...(type === 'cabinet' ? { shelf_rows: args.shelf_rows, two_deep: args.two_deep !== false, stagger: args.stagger !== false } : {}),
        group: result.rack.group || null, undo: 'undo_last deletes it while still empty',
      },
    };
    await logAction(ctx, {
      tool: 'create_rack', action: 'rack_create', cellar: access.cellar._id,
      detail: { rackId: String(result.rack._id), name: result.rack.name }, idempotencyKey: args.idempotency_key || null, result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'place_bottle',
  title: 'Place a bottle into a rack slot',
  description:
    'Puts one of the user\'s bottles into a specific rack position (the bottle must be in that rack\'s cellar). Moves ' +
    'the bottle if it was placed elsewhere, and reports any bottle displaced from the target slot. Reversible via ' +
    'undo_last (clears the slot again).',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    rack_id: objectId,
    position: z.number().int().min(1),
    bottle_id: objectId,
    idempotency_key: z.string().max(100).optional().describe('Retry-safe key: a retry with the same key returns the original result instead of placing twice.'),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'place_bottle');
    if (replayed) return replayed;
    const access = await resolveRackAccess(ctx.user.id, args.rack_id, 'editor');
    if (!access) return fail('not_found', 'No such rack, or you have no access to it. Use list_racks for valid ids.');
    const result = await placeBottleInRack(access.rack, args.position, args.bottle_id, ctx.req);
    if (result.error) {
      const code = result.error.code === 'conflict' ? 'conflict' : (result.error.status === 404 ? 'not_found' : 'invalid_input');
      return fail(code, result.error.message);
    }
    const envelope = {
      summary: `Placed bottle in "${access.rack.name}" position ${result.position}${result.displaced ? ' (displaced the bottle that was there)' : ''}`,
      data: {
        rack_id: access.rack._id, position: result.position, bottle_id: args.bottle_id,
        displaced_bottle_id: result.displaced, moved_from_position: result.previousPosition,
        undo: 'undo_last removes this bottle from the slot',
      },
    };
    await logAction(ctx, {
      tool: 'place_bottle', action: 'place', bottle: args.bottle_id, cellar: access.rack.cellar,
      // Undo needs the rack + the slot to clear.
      detail: { rackId: String(access.rack._id), position: result.position, displaced: result.displaced },
      result: envelope, idempotencyKey: args.idempotency_key,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'unplace_bottle',
  title: 'Remove a bottle from a rack slot',
  description: 'Clears one rack position (the bottle stays in the cellar, just unracked). Reversible via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    rack_id: objectId,
    position: z.number().int().min(1),
    idempotency_key: z.string().max(100).optional().describe('Retry-safe key: a retry with the same key returns the original result instead of acting twice.'),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'unplace_bottle');
    if (replayed) return replayed;
    const access = await resolveRackAccess(ctx.user.id, args.rack_id, 'editor');
    if (!access) return fail('not_found', 'No such rack, or you have no access to it. Use list_racks for valid ids.');
    const result = await clearRackSlot(access.rack, args.position, ctx.req);
    if (result.error) return fail(result.error.code === 'conflict' ? 'conflict' : 'invalid_input', result.error.message);
    const envelope = {
      summary: `Cleared position ${args.position} in "${access.rack.name}"`,
      data: { rack_id: access.rack._id, position: args.position, removed_bottle_id: result.cleared, undo: result.cleared ? 'undo_last puts the bottle back' : null },
    };
    await logAction(ctx, {
      tool: 'unplace_bottle', action: 'unplace', bottle: result.cleared || undefined, cellar: access.rack.cellar,
      detail: { rackId: String(access.rack._id), position: args.position, bottleId: result.cleared },
      result: envelope, idempotencyKey: args.idempotency_key,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'move_bottle',
  title: 'Move a bottle to another cellar',
  description:
    'Moves one ACTIVE bottle to a different cellar the user OWNS. It arrives unplaced (racking is separate). Confirm ' +
    'the destination first. Reversible via undo_last (moves it back).',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId,
    to_cellar_id: objectId,
    idempotency_key: z.string().max(100).optional().describe('Retry-safe key: a retry with the same key returns the original result instead of moving twice.'),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'move_bottle');
    if (replayed) return replayed;
    // Source: owner (matches REST requireBottleAccess('owner')).
    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'owner');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    // Destination: a cellar the user OWNS (not merely edits).
    const dest = await resolveCellarAccess(ctx.user.id, args.to_cellar_id, 'owner');
    if (!dest || String(dest.cellar.user) !== String(ctx.user.id)) {
      return fail('not_found', 'Destination cellar not found among the ones you own.');
    }
    const bottle = await Bottle.findById(access.bottle._id);
    const result = await moveBottleToCellar(bottle, access.cellar, dest.cellar, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'conflict' ? 'conflict' : 'invalid_input', result.error.message);
    }
    const envelope = {
      summary: `Moved bottle to "${dest.cellar.name}" (unplaced)`,
      data: { bottle_id: bottle._id, to_cellar_id: dest.cellar._id, from_cellar_id: result.from.cellarId, undo: 'undo_last moves it back' },
    };
    await logAction(ctx, {
      tool: 'move_bottle', action: 'move', bottle: bottle._id, cellar: dest.cellar._id,
      detail: { fromCellarId: result.from.cellarId, toCellarId: String(dest.cellar._id) },
      result: envelope, idempotencyKey: args.idempotency_key,
    });
    return ok(envelope.summary, envelope.data);
  },
});
