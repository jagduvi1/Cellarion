// Correcting and removing a saved bottle: change_bottle_wine [write] and
// delete_bottle [write]. Both run the SAME services as the app (bottle page
// "Change wine…", the bottle delete), so the two surfaces can never drift,
// and both are reversible through undo_last within the undo window.
//
// delete_bottle is the one destructive tool on the bottle surface. It asks
// for confirm:true, says up front what cannot come back (the owner's own
// photos — their files are deleted with the bottle), and keeps a snapshot in
// the action ledger so undo_last brings the bottle back under its own id.
const { z } = require('zod');
const { registerTool } = require('../registry');
const { findVisibleWine } = require('../../services/wineVisibility');
const { changeBottleWine, deleteBottleRecoverably } = require('../../services/bottleOps');
const { findLotSiblings, LOT_LIMIT } = require('../../services/bottleLot');
const { isValidId } = require('../../utils/validation');
const {
  ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess, wineSummary,
} = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');

const wineLabel = (w) => [w && w.producer, w && w.name].filter(Boolean).join(' — ');
const ownsCellar = (cellar, userId) => String(cellar.user && (cellar.user._id || cellar.user)) === String(userId);

registerTool({
  name: 'change_bottle_wine',
  title: 'Move a bottle to the right registry wine',
  description:
    'For a bottle saved under the WRONG registry wine (a red filed under the estate\'s white, a too-generic entry ' +
    'an import landed on, a twin picked by mistake): moves it to wine_id and keeps everything that is the user\'s ' +
    'own — vintage, dates, price, notes, rating, rack slot, history, personal data and photos. Find the right ' +
    'wine with resolve_wine or search_registry first, and confirm the move with the user (old wine → new wine). ' +
    'apply_to_lot: true also moves every other active bottle of the same wine and vintage in the user\'s own ' +
    'cellars. This is the same action as "Change wine…" on the bottle page. Reversible via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId,
    wine_id: objectId.describe('The registry wine the bottle really is (from resolve_wine / search_registry)'),
    apply_to_lot: z.boolean().optional().describe('Also move the other active bottles of the same wine and vintage in the user\'s own cellars'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'change_bottle_wine');
    if (replayed) return replayed;

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex Mongo id.');
    // Same visibility rule as adding a bottle: someone else's pending or
    // private draft wine is reported exactly like a missing id.
    const wineDoc = await findVisibleWine(args.wine_id, { userId: ctx.user.id, roles: ctx.user.roles });
    if (!wineDoc) return fail('not_found', 'No registry wine with that id. Use resolve_wine or search_registry.');

    const warnings = [];
    let siblings = [];
    if (args.apply_to_lot && !ownsCellar(access.cellar, ctx.user.id)) {
      warnings.push('apply_to_lot ignored: this bottle is in a cellar shared with you, and the lot would be your own bottles, not that cellar\'s.');
    } else if (args.apply_to_lot) {
      // Found BEFORE the move, so they are the old wine's lot.
      siblings = await findLotSiblings(ctx.user.id, bottle);
      if (siblings.length >= LOT_LIMIT) warnings.push(`The lot was capped at ${LOT_LIMIT} bottles.`);
    }

    const fromId = bottle.wineDefinition ? String(bottle.wineDefinition._id || bottle.wineDefinition) : null;
    const result = await changeBottleWine(bottle, wineDoc, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'same_wine' ? 'invalid_input' : 'conflict', result.error.message);
    }
    // prev: where each moved bottle came from — what undo_last moves them back to.
    const prev = { [String(bottle._id)]: fromId };
    const alsoMoved = [];
    for (const sib of siblings) {
      const sibFrom = sib.wineDefinition ? String(sib.wineDefinition._id || sib.wineDefinition) : null;
      const r = await changeBottleWine(sib, wineDoc, ctx.req);
      if (!r.error) { alsoMoved.push(String(sib._id)); prev[String(sib._id)] = sibFrom; }
    }

    const from = fromId ? await findVisibleWine(fromId, { userId: ctx.user.id, roles: ctx.user.roles }) : null;
    const envelope = {
      summary: `Moved bottle ${bottle._id} (vintage ${bottle.vintage}) ${from ? `from ${wineLabel(from)} ` : ''}to ${wineLabel(wineDoc)}` +
        (alsoMoved.length ? `; ${alsoMoved.length} other bottle(s) of the lot moved too` : ''),
      data: {
        bottle_id: bottle._id,
        from_wine_id: fromId,
        wine: { ...wineSummary(wineDoc) },
        ...(args.apply_to_lot ? { lot: { count: siblings.length, moved: alsoMoved } } : {}),
        undo: 'undo_last moves the bottle(s) back to the previous wine',
      },
    };
    await logAction(ctx, {
      tool: 'change_bottle_wine',
      action: 'change_wine',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { from: fromId, to: String(wineDoc._id), bottles: Object.keys(prev).length },
      prev,
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data, warnings.length ? { warnings } : undefined);
  },
});

registerTool({
  name: 'delete_bottle',
  title: 'Delete a bottle permanently (needs confirm)',
  description:
    'Deletes one bottle: gone from the cellar, its rack slot, search, stats and history. For cleaning up (an ' +
    'import duplicate, a bottle added twice, a history row that never happened). NOT for a bottle that was drunk, ' +
    'given away or sold — that is consume_bottle, which keeps the history. ALWAYS show the user the bottle first ' +
    '(get_bottle: wine, vintage, cellar, status, photos) and get an explicit yes, then call with confirm:true. ' +
    'The user\'s OWN photos of the bottle are deleted with it and cannot be restored; published registry photos ' +
    'stay with the wine. Reversible via undo_last for a few days: the bottle comes back under its own id with its ' +
    'notes, rating, dates and history, in its old rack slot if that is still free — but without its own photos.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId,
    confirm: z.boolean().describe('Must be true — only after the user explicitly agreed to delete this bottle'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    if (args.confirm !== true) {
      return fail('invalid_input', 'delete_bottle needs confirm:true — show the user the bottle (get_bottle) and ask before deleting.');
    }
    const replayed = await replay(ctx, args.idempotency_key, 'delete_bottle');
    if (replayed) return replayed;

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle, cellar } = access;
    const wineId = bottle.wineDefinition ? String(bottle.wineDefinition._id || bottle.wineDefinition) : null;
    const wine = wineId ? await findVisibleWine(wineId, { userId: ctx.user.id, roles: ctx.user.roles }) : null;
    const status = bottle.status;
    const vintage = bottle.vintage;

    const result = await deleteBottleRecoverably(bottle, ctx.req, { via: 'mcp' });
    if (result.error) return fail('conflict', result.error.message);
    const { snapshot, ownPhotosDeleted } = result;

    const envelope = {
      summary: `Deleted bottle ${bottle._id}${wine ? ` (${wineLabel(wine)} ${vintage})` : ` (vintage ${vintage})`} from "${cellar.name}"` +
        (ownPhotosDeleted ? `; its ${ownPhotosDeleted} own photo(s) were deleted permanently` : ''),
      data: {
        bottle_id: bottle._id,
        wine_id: wineId,
        vintage,
        status_was: status,
        cellar_id: cellar._id,
        rack_slot_freed: snapshot.rack ? snapshot.rack.position : null,
        own_photos_deleted: ownPhotosDeleted,
        undo: 'undo_last brings the bottle back (not its own photos)',
      },
    };
    await logAction(ctx, {
      tool: 'delete_bottle',
      action: 'delete',
      bottle: bottle._id,
      cellar: cellar._id,
      detail: { wine: wineId, vintage, status, own_photos_deleted: ownPhotosDeleted },
      // The snapshot undo_last restores from (services/bottleOps.restoreDeletedBottle).
      prev: snapshot,
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
