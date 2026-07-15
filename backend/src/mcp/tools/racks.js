// Rack read tools. list_racks is deliberately slot-free (occupancy summary
// only); get_rack returns the full slot map for one rack — keeps responses
// bounded instead of dumping every slot of every rack.
const { z } = require('zod');
const Rack = require('../../models/Rack');
const { registerTool } = require('../registry');
const { getMaxPosition } = require('../../utils/rackGeometry');
const { ok, fail, resolveCellarAccess } = require('../toolUtil');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-hex id');

registerTool({
  name: 'list_racks',
  title: 'List racks in a cellar',
  description:
    'Lists the racks of one cellar with type, dimensions, capacity, fill level and zone names — no per-slot detail. ' +
    'Call to get a rack overview or find a rack_id; use get_rack for the slot-by-slot map.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { cellar_id: objectId },
  handler: async (args, ctx) => {
    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
    if (!access) return fail('not_found', 'No such cellar, or you have no access to it. Use list_cellars for valid ids.');
    const racks = await Rack.find({ cellar: access.cellar._id, deletedAt: null }).lean();
    const data = racks.map((r) => {
      const capacity = Math.max(getMaxPosition(r) - (r.disabledPositions || []).length, 0);
      return {
        rack_id: r._id,
        name: r.name,
        type: r.isModular ? 'modular' : r.type,
        // Modular racks keep geometry in modules[]; the schema-default rows/cols
        // are meaningless there and would mislead placement reasoning.
        rows: r.isModular ? null : r.rows ?? null,
        cols: r.isModular ? null : r.cols ?? null,
        modules: r.isModular ? (r.modules || []).length : undefined,
        capacity,
        filled: (r.slots || []).length,
        free: Math.max(capacity - (r.slots || []).length, 0),
        zones: (r.zones || []).map((zn) => ({ name: zn.name, positions: (zn.positions || []).length })),
      };
    });
    return ok(`${data.length} rack(s) in "${access.cellar.name}"`, data);
  },
});

registerTool({
  name: 'get_rack',
  title: 'Get one rack (slot map)',
  description:
    'Full slot map of one rack: every occupied position with its bottle (wine, producer, vintage), plus zones and ' +
    'disabled positions. Call when the user asks where something is, what is in a rack, or before reasoning about placement.',
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
        populate: { path: 'wineDefinition', select: 'name producer type' },
      })
      .lean();
    if (!rack) return fail('not_found', NOT_FOUND);
    const slots = (rack.slots || [])
      .filter((s) => s.bottle)
      .map((s) => ({
        position: s.position,
        bottle_id: s.bottle._id,
        wine: s.bottle.wineDefinition
          ? { name: s.bottle.wineDefinition.name, producer: s.bottle.wineDefinition.producer || null, type: s.bottle.wineDefinition.type || null }
          : null,
        vintage: s.bottle.vintage,
      }))
      .sort((a, b) => a.position - b.position);
    const capacity = Math.max(getMaxPosition(rack) - (rack.disabledPositions || []).length, 0);
    return ok(`Rack "${rack.name}": ${slots.length}/${capacity} filled`, {
      rack_id: rack._id,
      name: rack.name,
      cellar_id: rack.cellar,
      type: rack.isModular ? 'modular' : rack.type,
      rows: rack.isModular ? null : rack.rows ?? null,
      cols: rack.isModular ? null : rack.cols ?? null,
      modules: rack.isModular
        ? (rack.modules || []).map((m) => ({ type: m.type, rows: m.rows, cols: m.cols }))
        : undefined,
      capacity,
      disabled_positions: rack.disabledPositions || [],
      zones: (rack.zones || []).map((zn) => ({ name: zn.name, color: zn.color || null, positions: zn.positions || [] })),
      slots,
    });
  },
});
