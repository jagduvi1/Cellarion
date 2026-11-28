// Cellar / rack / placement write tools; auto-arrange is in arrange.js. A grid,
// a cabinet or a wall (modular racks, zones, disabled-slot management and
// changing a rack's shape: the web app).
// All mutations run through services/rackOps — the SAME code the REST routes
// use, so the procedural one-bottle-per-slot invariant and the move ordering
// can't drift between surfaces.
const { z } = require('zod');
const Rack = require('../../models/Rack');
const Bottle = require('../../models/Bottle');
const { registerTool } = require('../registry');
const {
  createCellar, createGridRack, placeBottleInRack, clearRackSlot,
  MOVE_MIN_ROLE, findMoveDestination, moveBottleToCellar,
} = require('../../services/rackOps');
const {
  ok, fail, objectId, MSG_CELLAR_NOT_FOUND, MSG_BOTTLE_NOT_FOUND,
  resolveCellarAccess, resolveBottleAccess, wallSpot, wallText,
} = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');
const { totalSlots, slotPlace } = require('../../utils/rackGeometry');
const { BOX_KINDS, PILE_SECTIONS, WALL_MAX_PER_SECTION, WALL_MAX_BOX_DIM } = require('../../utils/wallGeometry');

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
    'neck two rows deep (default true), stagger = stacked rows nest in the grooves of the row below (default true, ' +
    'drawing only), head_to_tail = a one-deep row lies head to tail, every other bottle neck forward (needs two_deep ' +
    'false; drawing only), alternate = rows alternate cols / cols−1 like a honeycomb (6 in front of 5, then 5 in front of 6; ' +
    'default false, changes capacity); shelf_cols / shelf_alternate override width and pattern per shelf (a Liebherr ' +
    'GrandCru 5001: 5 shelves 6 across, shelf_rows [8,8,8,8,8], shelf_cols [4,6,6,6,4], shelf_alternate ' +
    '[false,true,true,true,false] = 196); shelf_sideways sets how each shelf\'s bottles lie — "front" = the first bottle of the ' +
    'shelf\'s bottom row lies across the front of the others (a slim fridge), "all" = every bottle lies across (a bottom bin), ' +
    '"" = front to back (drawing only, except "front" on a stacked one-deep shelf — see shelf_sideways). ' +
    'type "wall": one rack built from boxes, for shelving made of wine cubes, diagonal bins, shelves and cupboards — rows × cols ' +
    'are the wall\'s cells and boxes lists what stands where (see boxes). Confirm name and shape first; group is the optional room or appliance label ' +
    'the rack belongs to ("Basement", "Kitchen fridge") — reuse a group name list_racks already shows so racks ' +
    'section together. For other rack shapes, modular racks, zones or disabled slots, use the web app. Reversible ' +
    'via undo_last while the rack is still empty.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    cellar_id: objectId,
    name: z.string().min(1).max(120),
    type: z.enum(['grid', 'cabinet', 'wall']).default('grid').describe('"grid" = rows × cols slots; "cabinet" = a wine fridge with shelves (see shelf_rows); "wall" = one rack built from boxes (see boxes)'),
    rows: z.number().int().min(1).max(20).optional().describe('Rows of slots (grid), number of shelves (cabinet), or cells high (wall). Default 4; a wall: as high as its boxes reach'),
    cols: z.number().int().min(1).max(20).optional().describe('Slots per row (grid), bottles across one row (cabinet), or cells wide (wall). Default 8; a wall: as wide as its boxes reach'),
    boxes: z.array(z.object({
      x: z.number().int().min(0).max(19).describe('Column of the box\'s top-left cell, 0 = the left-most'),
      y: z.number().int().min(0).max(19).describe('Row of the box\'s top-left cell, 0 = the top'),
      w: z.number().int().min(1).max(20).default(1).describe('Cells wide'),
      h: z.number().int().min(1).max(20).default(1).describe('Cells high'),
      kind: z.enum(BOX_KINDS).describe('"x" = two crossing planks, four triangular piles; "slash" = one plank from bottom left to top right, two piles; "backslash" = one plank from top left to bottom right, two piles; "bin" = an open bin, one pile; "rack" = single slots in rows; "shelves" = bottles standing on shelves; "closed" = doors or a drawer, holds no bottles'),
      per_pile: z.number().int().min(1).max(WALL_MAX_PER_SECTION).optional().describe('Bottles in each pile of an x, slash, backslash or bin'),
      rows: z.number().int().min(1).max(WALL_MAX_BOX_DIM).optional().describe('rack: rows of slots; shelves: number of shelves'),
      cols: z.number().int().min(1).max(WALL_MAX_BOX_DIM).optional().describe('rack: slots per row; shelves: bottles per shelf'),
    })).min(1).max(400).optional()
      .describe('Wall only: the boxes on the wall\'s grid of rows × cols cells. A box covers one cell or a rectangle of cells; boxes must not overlap, and a cell no box covers is empty wall. A wine cube with an X holding six bottles a triangle: { x: 0, y: 0, kind: "x", per_pile: 6 }. Required for type "wall".'),
    shelf_rows: z.array(z.number().int().min(1).max(12)).min(1).max(20).optional()
      .describe('Cabinet only: rows of bottles per shelf, top shelf first, one entry per shelf (must equal rows). Required for type "cabinet".'),
    two_deep: z.boolean().optional().describe('Cabinet only: bottles lie neck to neck, two rows deep per level (default true)'),
    stagger: z.boolean().optional().describe('Cabinet only: stacked rows nest in the grooves of the row below, offset half a bottle (default true). Drawing only — capacity is unchanged.'),
    head_to_tail: z.boolean().optional().describe('Cabinet only, with two_deep false: the bottles of a row lie head to tail, every other one neck forward (default false). Drawing only — capacity and numbering are unchanged.'),
    alternate: z.boolean().optional().describe('Cabinet only: rows alternate in width like a honeycomb — the first level holds cols bottles in front of cols−1, the level above cols−1 in front of cols, and so on (a Liebherr GrandCru shelf: 6 / 5 then 5 / 6). Default false. CHANGES capacity, so pass it only when the cabinet really stacks that way.'),
    shelf_cols: z.array(z.number().int().min(1).max(20)).min(1).max(20).optional()
      .describe('Cabinet only: bottles across per shelf, top shelf first, one entry per shelf (must equal rows), each 1..cols — for shelves narrower than the cabinet. Omit when every shelf is cols wide.'),
    shelf_alternate: z.array(z.boolean()).min(1).max(20).optional()
      .describe('Cabinet only: whether each shelf alternates (see alternate), top shelf first, one entry per shelf (must equal rows). Omit when every shelf follows the cabinet-wide alternate flag.'),
    shelf_sideways: z.array(z.enum(['', 'front', 'all'])).min(1).max(20).optional()
      .describe('Cabinet only: how each shelf\'s bottles lie, top shelf first, one entry per shelf (must equal rows): "" front to back, "front" = the first bottle of the bottom row lies across the front of the others, "all" = every bottle lies across (a bottom bin). Drawing only, except on a stacked shelf (shelf_rows > 1) of a one-deep cabinet: there "front" leaves one bottle fewer on each level above the first, as they rest on the bottles behind the one across (shelf_cols 5 + shelf_alternate true + "front" = 1 across + 4, with 3 on top). Omit when every shelf lies front to back.'),
    group: z.string().max(40).optional().describe('Optional group label (room or appliance), e.g. "Basement"'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'create_rack');
    if (replayed) return replayed;
    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id, 'editor');
    if (!access) return fail('not_found', MSG_CELLAR_NOT_FOUND);
    const type = args.type || 'grid';
    // A wall is as large as its boxes reach when the caller states no size.
    const reach = (from, span) => (type === 'wall' && Array.isArray(args.boxes)
      ? Math.min(20, Math.max(...args.boxes.map((b) => b[from] + (b[span] ?? 1))))
      : undefined);
    const rows = args.rows ?? reach('y', 'h') ?? 4;
    const cols = args.cols ?? reach('x', 'w') ?? 8;
    let typeConfig;
    if (type === 'cabinet') {
      if (!Array.isArray(args.shelf_rows)) {
        return fail('invalid_input', 'shelf_rows is required for a cabinet: one entry per shelf, rows of bottles each shelf holds (top shelf first)');
      }
      typeConfig = {
        shelfRows: args.shelf_rows, twoDeep: args.two_deep !== false, stagger: args.stagger !== false, alternate: args.alternate === true,
        ...(args.head_to_tail !== undefined ? { headToTail: args.head_to_tail } : {}),
        ...(args.shelf_cols ? { shelfCols: args.shelf_cols } : {}),
        ...(args.shelf_alternate ? { shelfAlternate: args.shelf_alternate } : {}),
        ...(args.shelf_sideways ? { shelfSideways: args.shelf_sideways } : {}),
      };
    } else if (['shelf_rows', 'two_deep', 'stagger', 'head_to_tail', 'alternate', 'shelf_cols', 'shelf_alternate', 'shelf_sideways'].some((k) => args[k] !== undefined)) {
      return fail('invalid_input', 'shelf_rows, two_deep, stagger, head_to_tail, alternate, shelf_cols, shelf_alternate and shelf_sideways apply to type "cabinet" only');
    }
    if (type === 'wall') {
      if (!Array.isArray(args.boxes)) {
        return fail('invalid_input', 'boxes is required for a wall: the boxes on its grid of rows × cols cells, each { x, y, kind } with what it holds');
      }
      // What a box must state, said in this tool's own field names: the
      // shared check below answers in the stored ones (perSection).
      for (const b of args.boxes) {
        const where = `The "${b.kind}" box at x ${b.x}, y ${b.y}`;
        if (PILE_SECTIONS[b.kind] && b.per_pile === undefined) {
          return fail('invalid_input', `${where} needs per_pile: the bottles in each of its piles (1 to ${WALL_MAX_PER_SECTION})`);
        }
        if ((b.kind === 'rack' || b.kind === 'shelves') && (b.rows === undefined || b.cols === undefined)) {
          return fail('invalid_input', `${where} needs rows and cols (1 to ${WALL_MAX_BOX_DIM} each)`);
        }
      }
      // The stored names (models/Rack wallBoxSchema), and of the sizes only
      // what the box's kind uses; the rules are checked by createGridRack
      // through utils/wallGeometry.validateWallConfig.
      typeConfig = {
        boxes: args.boxes.map((b) => ({
          x: b.x, y: b.y, w: b.w ?? 1, h: b.h ?? 1, kind: b.kind,
          ...(PILE_SECTIONS[b.kind] ? { perSection: b.per_pile } : {}),
          ...(b.kind === 'rack' || b.kind === 'shelves' ? { rows: b.rows, cols: b.cols } : {}),
        })),
      };
    } else if (args.boxes !== undefined) {
      return fail('invalid_input', 'boxes applies to type "wall" only');
    }
    const result = await createGridRack(access.cellar, { name: args.name, type, rows, cols, typeConfig, group: args.group }, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'duplicate' ? 'conflict' : 'invalid_input', result.error.message);
    }
    // Geometry owns the count: an alternating cabinet's rows are not all `cols` wide.
    const capacity = type === 'grid' ? rows * cols : totalSlots(type, rows, cols, typeConfig);
    const envelope = {
      summary: type === 'cabinet'
        ? `Created wine cabinet "${result.rack.name}" in "${access.cellar.name}": ${rows} shelves, ${cols} across, ${capacity} bottles`
        : type === 'wall'
          ? `Created wall "${result.rack.name}" in "${access.cellar.name}": ${cols} cells wide, ${rows} high, ${typeConfig.boxes.length} boxes, ${capacity} bottles`
          : `Created ${rows}×${cols} rack "${result.rack.name}" in "${access.cellar.name}"`,
      data: {
        rack_id: result.rack._id, cellar_id: access.cellar._id, type, rows, cols, capacity,
        ...(type === 'cabinet' ? {
          shelf_rows: args.shelf_rows, two_deep: args.two_deep !== false, stagger: args.stagger !== false, alternate: args.alternate === true,
          head_to_tail: args.head_to_tail === true,
          shelf_cols: args.shelf_cols || null, shelf_alternate: args.shelf_alternate || null, shelf_sideways: args.shelf_sideways || null,
        } : {}),
        ...(type === 'wall' ? { boxes: typeConfig.boxes.length } : {}),
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
    'the bottle if it was placed elsewhere, and reports any bottle displaced from the target slot. On a wall rack the ' +
    'answer says which box and spot that position is (wall): check it is the place the user meant, and find the ' +
    'position of a box or pile with get_rack first. Reversible via undo_last (clears the slot again).',
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
    // A wall rack: the box and the spot in it, to hold against what the user meant.
    const wall = slotPlace(access.rack, result.position);
    const envelope = {
      summary: `Placed bottle in "${access.rack.name}" position ${result.position}${wall ? ` (${wallText(wall)})` : ''}${result.displaced ? ' (displaced the bottle that was there)' : ''}`,
      data: {
        rack_id: access.rack._id, position: result.position, ...(wall ? { wall: wallSpot(wall) } : {}), bottle_id: args.bottle_id,
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
    const wall = slotPlace(access.rack, args.position);
    const envelope = {
      summary: `Cleared position ${args.position}${wall ? ` (${wallText(wall)})` : ''} in "${access.rack.name}"`,
      data: {
        rack_id: access.rack._id, position: args.position, ...(wall ? { wall: wallSpot(wall) } : {}),
        removed_bottle_id: result.cleared, undo: result.cleared ? 'undo_last puts the bottle back' : null,
      },
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
    'Moves one ACTIVE bottle (or one still on order) to a different cellar. The user must own or edit both cellars, so a bottle can go ' +
    'into or out of a cellar shared with them as editor. A bottle belongs to the owner of the cellar it is in: moved into a cellar ' +
    'someone else owns, it becomes theirs. It arrives unplaced (racking is separate). Confirm the destination first, and say whose ' +
    'cellar it is when it is not the user\'s own. Reversible via undo_last (moves it back) while the user still edits both cellars.',
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
    // The REST move's rule on both cellars (rackOps.MOVE_MIN_ROLE).
    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, MOVE_MIN_ROLE);
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const destCellar = await findMoveDestination(ctx.user.id, args.to_cellar_id);
    if (!destCellar) {
      return fail('not_found', 'Destination cellar not found among the ones you own or edit.');
    }
    const bottle = await Bottle.findById(access.bottle._id);
    const result = await moveBottleToCellar(bottle, access.cellar, destCellar, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'conflict' ? 'conflict' : 'invalid_input', result.error.message);
    }
    const envelope = {
      summary: `Moved bottle to "${destCellar.name}" (unplaced)`,
      data: { bottle_id: bottle._id, to_cellar_id: destCellar._id, from_cellar_id: result.from.cellarId, undo: 'undo_last moves it back' },
    };
    await logAction(ctx, {
      tool: 'move_bottle', action: 'move', bottle: bottle._id, cellar: destCellar._id,
      detail: { fromCellarId: result.from.cellarId, toCellarId: String(destCellar._id) },
      result: envelope, idempotencyKey: args.idempotency_key,
    });
    return ok(envelope.summary, envelope.data);
  },
});
