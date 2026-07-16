// Cellar read tools. PII rule: member EMAILS are never returned over MCP —
// the REST /members and /audit sub-routes are TOKEN_EXCLUSIONS for the same
// reason; here we return only counts and the caller's own role.
const { z } = require('zod');
const Bottle = require('../../models/Bottle');
const Rack = require('../../models/Rack');
const { CONSUMED_STATUSES } = require('../../config/constants');
const { registerTool } = require('../registry');
const { getCellarRole } = require('../../utils/cellarAccess');
const { ok, fail, resolveCellarAccess, accessibleCellars } = require('../toolUtil');

registerTool({
  name: 'list_cellars',
  title: 'List my cellars',
  description:
    'Lists every cellar the user owns or is a member of, with their role and the number of active bottles in each. ' +
    'Call this first when you need a cellar_id for other tools, or when the user asks what cellars they have.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  handler: async (_args, ctx) => {
    const cellars = await accessibleCellars(ctx.user.id);
    const ids = cellars.map((c) => c._id);
    const counts = await Bottle.aggregate([
      { $match: { cellar: { $in: ids }, status: { $nin: CONSUMED_STATUSES } } },
      { $group: { _id: '$cellar', n: { $sum: 1 } } },
    ]);
    const countByCellar = new Map(counts.map((c) => [String(c._id), c.n]));
    const data = cellars.map((c) => ({
      cellar_id: c._id,
      name: c.name,
      description: c.description || null,
      role: getCellarRole(c, ctx.user.id),
      active_bottles: countByCellar.get(String(c._id)) || 0,
      shared: (c.members || []).length > 0,
    }));
    return ok(`${data.length} cellar(s)`, data);
  },
});

registerTool({
  name: 'get_cellar',
  title: 'Get one cellar',
  description:
    'Returns one cellar\'s summary: name, your role, active-bottle count, consumed count, rack count, member count. ' +
    'Call when the user refers to a specific cellar and you already know its cellar_id (from list_cellars).',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { cellar_id: z.string().describe('Cellar id from list_cellars') },
  handler: async (args, ctx) => {
    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
    if (!access) return fail('not_found', 'No such cellar, or you have no access to it. Use list_cellars for valid ids.');
    const { cellar, role } = access;
    const [active, consumed, racks] = await Promise.all([
      Bottle.countDocuments({ cellar: cellar._id, status: { $nin: CONSUMED_STATUSES } }),
      Bottle.countDocuments({ cellar: cellar._id, status: { $in: CONSUMED_STATUSES } }),
      Rack.countDocuments({ cellar: cellar._id, deletedAt: null }),
    ]);
    return ok(`Cellar "${cellar.name}"`, {
      cellar_id: cellar._id,
      name: cellar.name,
      description: cellar.description || null,
      role,
      active_bottles: active,
      consumed_bottles: consumed,
      racks,
      member_count: (cellar.members || []).length,
      created_at: cellar.createdAt,
    });
  },
});
