// Rack read tools. list_racks is deliberately slot-free (occupancy summary
// only); get_rack returns the full slot map for one rack — keeps responses
// bounded instead of dumping every slot of every rack.
const Rack = require('../../models/Rack');
const { registerTool } = require('../registry');
const { getMaxPosition, slotPlace } = require('../../utils/rackGeometry');
const { wallRanges } = require('../../utils/wallGeometry');
const { ok, fail, objectId, MSG_CELLAR_NOT_FOUND, resolveCellarAccess } = require('../toolUtil');

// A wall rack is one rack built from boxes (utils/wallGeometry). Its boxes in
// position order, each with what it is, how many cells it covers, what it
// holds and the positions it has; a closed box has none.
const isWall = (r) => r.type === 'wall' && !r.isModular;
function wallBoxesOf(r) {
  return wallRanges(r.rows, r.cols, r.typeConfig).map(({ box, label, start, capacity }) => ({
    box: label,
    kind: box.kind,
    cells_wide: box.w,
    cells_high: box.h,
    ...(box.perSection != null && capacity ? { per_pile: box.perSection } : {}),
    ...(box.kind === 'rack' || box.kind === 'shelves' ? { rows: box.rows, cols: box.cols } : {}),
    capacity,
    positions: capacity ? { from: start + 1, to: start + capacity } : null,
  }));
}

registerTool({
  name: 'list_racks',
  title: 'List racks in a cellar',
  description:
    'Lists the racks of one cellar with type, dimensions, capacity, fill level, zone names and the user\'s group label ' +
    '(a room or appliance such as "Basement" or "Kitchen fridge"; null = ungrouped) — no per-slot detail. ' +
    'A rack of type "wall" is one rack built from boxes: rows × cols are its cells and boxes is how many boxes it has. ' +
    'Call to get a rack overview or find a rack_id; use get_rack for the slot-by-slot map.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { cellar_id: objectId },
  handler: async (args, ctx) => {
    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
    if (!access) return fail('not_found', MSG_CELLAR_NOT_FOUND);
    const racks = await Rack.find({ cellar: access.cellar._id, deletedAt: null }).lean();
    const data = racks.map((r) => {
      const capacity = Math.max(getMaxPosition(r) - (r.disabledPositions || []).length, 0);
      return {
        rack_id: r._id,
        name: r.name,
        group: r.group || null,
        type: r.isModular ? 'modular' : r.type,
        // Modular racks keep geometry in modules[]; the schema-default rows/cols
        // are meaningless there and would mislead placement reasoning.
        rows: r.isModular ? null : r.rows ?? null,
        cols: r.isModular ? null : r.cols ?? null,
        // Cabinet (wine fridge): rows = shelves, cols = bottles across; the
        // per-shelf row list + two-deep flag complete the shape.
        ...(r.type === 'cabinet' && !r.isModular
          ? {
            shelf_rows: r.typeConfig?.shelfRows || null, two_deep: r.typeConfig?.twoDeep !== false, stagger: r.typeConfig?.stagger !== false, head_to_tail: r.typeConfig?.headToTail === true, alternate: r.typeConfig?.alternate === true,
            shelf_cols: r.typeConfig?.shelfCols || null, shelf_alternate: r.typeConfig?.shelfAlternate || null, shelf_sideways: r.typeConfig?.shelfSideways || null,
          }
          : {}),
        modules: r.isModular ? (r.modules || []).length : undefined,
        ...(isWall(r) ? { boxes: wallBoxesOf(r).length } : {}),
        capacity,
        filled: (r.slots || []).length,
        free: Math.max(capacity - (r.slots || []).length, 0),
        zones: (r.zones || []).map((zn) => ({ name: zn.name, positions: (zn.positions || []).length })),
      };
    });
    const groups = [...new Set(data.map((r) => r.group).filter(Boolean))];
    return ok(`${data.length} rack(s) in "${access.cellar.name}"${groups.length ? ` — groups: ${groups.join(', ')}` : ''}`, data);
  },
});

registerTool({
  name: 'get_rack',
  title: 'Get one rack (slot map)',
  description:
    'Full slot map of one rack: every occupied position with its bottle (wine, producer, vintage), plus zones and ' +
    'disabled positions. Call when the user asks where something is, what is in a rack, or before reasoning about placement. ' +
    'For a rack of type "wall" (one rack built from boxes) it also lists the boxes with what each is and the positions it holds, ' +
    'and each slot says its box and the spot in it (wall): say "box B2, left pile, third from the bottom", not the position number.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { rack_id: objectId.describe('Rack id from list_racks') },
  handler: async (args, ctx) => {
    // Access check BEFORE the slot populate: no DB work on foreign racks, and
    // one identical not_found for missing and foreign alike — a caller probing
    // rack ids cannot distinguish "exists but not yours" from "doesn't exist".
    const NOT_FOUND = 'No such rack, or you have no access to it. Use list_racks for valid ids.';
    const stub = await Rack.findOne({ _id: args.rack_id, deletedAt: null }).select('cellar').lean();
    if (!stub) return fail('not_found', NOT_FOUND);
    const access = await resolveCellarAccess(ctx.user.id, stub.cellar);
    if (!access) return fail('not_found', NOT_FOUND);
    const rack = await Rack.findOne({ _id: args.rack_id, deletedAt: null })
      .populate({
        path: 'slots.bottle',
        select: 'vintage status wineDefinition',
        populate: { path: 'wineDefinition', select: 'name producer type colour' },
      })
      .lean();
    if (!rack) return fail('not_found', NOT_FOUND);
    const slots = (rack.slots || [])
      .filter((s) => s.bottle)
      .map((s) => ({
        position: s.position,
        bottle_id: s.bottle._id,
        wine: s.bottle.wineDefinition
          ? {
              name: s.bottle.wineDefinition.name, producer: s.bottle.wineDefinition.producer || null, type: s.bottle.wineDefinition.type || null,
              // Additive, only when set: a sparkling rosé is type sparkling + colour rosé.
              ...(s.bottle.wineDefinition.colour ? { colour: s.bottle.wineDefinition.colour } : {}),
            }
          : null,
        vintage: s.bottle.vintage,
        // A wall rack: the box and the spot in it (pile + count from the bottom, or row + col).
        ...(isWall(rack) ? { wall: slotPlace(rack, s.position) } : {}),
      }))
      .sort((a, b) => a.position - b.position);
    const capacity = Math.max(getMaxPosition(rack) - (rack.disabledPositions || []).length, 0);
    return ok(`Rack "${rack.name}"${rack.group ? ` (${rack.group})` : ''}: ${slots.length}/${capacity} filled`, {
      rack_id: rack._id,
      name: rack.name,
      group: rack.group || null,
      cellar_id: rack.cellar,
      type: rack.isModular ? 'modular' : rack.type,
      rows: rack.isModular ? null : rack.rows ?? null,
      cols: rack.isModular ? null : rack.cols ?? null,
      // Cabinet: the per-shelf row list is what turns a position into
      // "shelf N, row R" (see the position contract in the instructions).
      ...(rack.type === 'cabinet' && !rack.isModular
        ? {
          shelf_rows: rack.typeConfig?.shelfRows || null, two_deep: rack.typeConfig?.twoDeep !== false, stagger: rack.typeConfig?.stagger !== false, head_to_tail: rack.typeConfig?.headToTail === true, alternate: rack.typeConfig?.alternate === true,
          shelf_cols: rack.typeConfig?.shelfCols || null, shelf_alternate: rack.typeConfig?.shelfAlternate || null, shelf_sideways: rack.typeConfig?.shelfSideways || null,
        }
        : {}),
      modules: rack.isModular
        ? (rack.modules || []).map((m) => ({ type: m.type, rows: m.rows, cols: m.cols }))
        : undefined,
      // Wall: rows × cols are its cells; the boxes are listed in position order.
      ...(isWall(rack) ? { boxes: wallBoxesOf(rack) } : {}),
      capacity,
      disabled_positions: rack.disabledPositions || [],
      zones: (rack.zones || []).map((zn) => ({ name: zn.name, color: zn.color || null, positions: zn.positions || [] })),
      slots,
    });
  },
});
