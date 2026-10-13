// Pick lists (forum request 2026-10-13): named lists of the user's own bottles
// to fetch, each with its cellar, rack and slot. The same service as REST
// /api/pick-lists (services/pickListOps), so an assistant and the app see and
// change the same lists. Not undoable through undo_last: every change here is
// itself reversible (add ↔ remove, tick ↔ untick), and a delete asks for
// confirm:true.
const { z } = require('zod');
const { registerTool } = require('../registry');
const { ok, fail, objectId } = require('../toolUtil');
const {
  listPickLists, createPickList, renamePickList, addToPickList, removeFromPickList,
  setPicked, deletePickList, getPickListView,
} = require('../../services/pickListOps');

const CODE = { 400: 'invalid_input', 404: 'not_found', 409: 'conflict' };
const failFrom = (error) => fail(CODE[error.status] || 'error', error.message);
const ids = z.array(objectId).max(500);

const itemOut = (it) => (it.state === 'unavailable'
  ? { bottle_id: it.bottleId, state: 'unavailable', picked: !!it.pickedAt }
  : {
      bottle_id: it.bottleId,
      state: it.state,
      picked: !!it.pickedAt,
      wine: [it.wine.producer, it.wine.name].filter(Boolean).join(' — '),
      vintage: it.vintage,
      bottle_size: it.bottleSize,
      cellar: it.cellar.name,
      rack: it.rack ? it.rack.rackName : null,
      slot: it.rack ? it.rack.position : null,
      location: it.rack ? null : it.location,
    });

registerTool({
  name: 'list_pick_lists',
  title: 'List pick lists',
  description:
    'The user\'s pick lists: named lists of their bottles to fetch from the cellar ("Saturday dinner", "Drink next"), ' +
    'with how many bottles each holds and how many are ticked as picked. Use get_pick_list for the bottles and where they sit.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  handler: async (args, ctx) => {
    const { lists } = await listPickLists(ctx.user.id);
    return ok(`${lists.length} pick list(s)`, lists.map((l) => ({
      pick_list_id: l.id, name: l.name, bottles: l.count, picked: l.picked, updated_at: l.updatedAt,
    })));
  },
});

registerTool({
  name: 'get_pick_list',
  title: 'Show a pick list',
  description:
    'One pick list in walking order: each bottle with its wine, vintage, cellar, rack and slot (or its free-text location ' +
    'when it is not in a rack), whether it is ticked as picked, and its state: in_cellar, drunk (no longer in the cellar), ' +
    'ordered, or unavailable (deleted, or in a cellar the user can no longer see).',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { pick_list_id: objectId.describe('From list_pick_lists') },
  handler: async (args, ctx) => {
    const res = await getPickListView(ctx.user.id, args.pick_list_id);
    if (res.error) return failFrom(res.error);
    const { list } = res;
    return ok(`"${list.name}" — ${list.count} bottle(s), ${list.picked} picked`, {
      pick_list_id: list.id, name: list.name, items: list.items.map(itemOut),
    });
  },
});

registerTool({
  name: 'create_pick_list',
  title: 'Create a pick list',
  description:
    'Creates a named pick list, optionally with bottles (bottle ids from search_bottles). Only bottles in a cellar the user ' +
    'can see and still in the cellar are added; the rest come back in skipped with a reason.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    name: z.string().min(1).max(100),
    bottle_ids: ids.optional(),
  },
  handler: async (args, ctx) => {
    const res = await createPickList(ctx.user.id, { name: args.name, bottleIds: args.bottle_ids || [] }, ctx.req);
    if (res.error) return failFrom(res.error);
    return ok(`Created "${res.list.name}" with ${res.added} bottle(s)`, {
      pick_list_id: res.list.id, added: res.added, skipped: res.skipped,
    });
  },
});

registerTool({
  name: 'update_pick_list',
  title: 'Change a pick list',
  description:
    'Renames a pick list, adds or removes bottles, and ticks bottles as picked or unticks them — any combination in one ' +
    'call, applied in that order. Ticking marks where the user is while fetching; it does not change the bottle. To log ' +
    'picked bottles as drunk, use consume_bottle for each.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    pick_list_id: objectId.describe('From list_pick_lists'),
    name: z.string().min(1).max(100).optional(),
    add_bottle_ids: ids.optional(),
    remove_bottle_ids: ids.optional(),
    picked_bottle_ids: ids.optional().describe('Tick these as picked'),
    unpicked_bottle_ids: ids.optional().describe('Untick these'),
  },
  handler: async (args, ctx) => {
    const done = {};
    if (args.name !== undefined) {
      const r = await renamePickList(ctx.user.id, args.pick_list_id, args.name, ctx.req);
      if (r.error) return failFrom(r.error);
      done.renamed = r.list.name;
    }
    if (args.add_bottle_ids?.length) {
      const r = await addToPickList(ctx.user.id, args.pick_list_id, args.add_bottle_ids, ctx.req);
      if (r.error) return failFrom(r.error);
      done.added = r.added;
      if (r.skipped.length) done.skipped = r.skipped;
    }
    if (args.remove_bottle_ids?.length) {
      const r = await removeFromPickList(ctx.user.id, args.pick_list_id, args.remove_bottle_ids, ctx.req);
      if (r.error) return failFrom(r.error);
      done.removed = r.removed;
    }
    for (const [key, picked] of [['picked_bottle_ids', true], ['unpicked_bottle_ids', false]]) {
      if (!args[key]?.length) continue;
      const r = await setPicked(ctx.user.id, args.pick_list_id, args[key], picked);
      if (r.error) return failFrom(r.error);
      done[picked ? 'ticked' : 'unticked'] = args[key].length;
    }
    if (!Object.keys(done).length) return fail('invalid_input', 'Nothing to change: pass name, add/remove bottle ids, or picked/unpicked ids.');
    const view = await getPickListView(ctx.user.id, args.pick_list_id);
    const list = view.list;
    return ok(`"${list.name}" — ${list.count} bottle(s), ${list.picked} picked`, { pick_list_id: list.id, ...done });
  },
});

registerTool({
  name: 'delete_pick_list',
  title: 'Delete a pick list',
  description:
    'Deletes a pick list for good (the bottles themselves are not touched). Needs confirm:true after the user said yes.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    pick_list_id: objectId.describe('From list_pick_lists'),
    confirm: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    if (args.confirm !== true) return fail('invalid_input', 'delete_pick_list needs confirm:true — ask the user first. It cannot be undone (the bottles are not touched).');
    const r = await deletePickList(ctx.user.id, args.pick_list_id, ctx.req);
    if (r.error) return failFrom(r.error);
    return ok('Pick list deleted', { pick_list_id: args.pick_list_id, deleted: true });
  },
});
