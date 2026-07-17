// undo_last reversals for the Phase-2c structural actions (create_cellar,
// create_rack, place_bottle, unplace_bottle, move_bottle). Kept out of
// consume.js to hold that file's size down. Every reversal:
//   - re-checks access (a lost role/ownership since the action = refuse),
//   - claims the ledger row atomically BEFORE mutating (McpActionLog has no
//     optimistic concurrency; plain save is not a guard),
//   - records a viaUndo:true row so sequential undos walk backward.
const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const { getMaxPosition } = require('../utils/rackGeometry');
const { placeBottleInRack, clearRackSlot, moveBottleToCellar } = require('../services/rackOps');
const { resolveBottleAccess, resolveCellarAccess } = require('./toolUtil');

/** Atomic single-use claim on the ledger row. */
async function claim(last) {
  return McpActionLog.findOneAndUpdate(
    { _id: last._id, reversed: false },
    { $set: { reversed: true, idempotencyKey: null } }
  );
}

async function undoStructural(last, ctx, { ok, fail, logAction }) {
  const record = async (envelope, extra = {}) => {
    await logAction(ctx, {
      tool: 'undo_last', action: last.action, viaUndo: true,
      cellar: last.cellar, detail: { undid: String(last._id) }, result: envelope, ...extra,
    });
    return ok(envelope.summary, envelope.data);
  };

  if (last.action === 'cellar_create') {
    const cellar = await Cellar.findOne({ _id: last.cellar, user: ctx.user.id, deletedAt: null });
    if (!cellar) return fail('conflict', 'That cellar no longer exists or is not yours; nothing was changed.');
    const [bottles, racks] = await Promise.all([
      Bottle.countDocuments({ cellar: cellar._id }),
      Rack.countDocuments({ cellar: cellar._id, deletedAt: null }),
    ]);
    if (bottles || racks) {
      return fail('conflict', 'That cellar now has bottles or racks — remove them in the web app before deleting it. Nothing was changed.');
    }
    if (!(await claim(last))) return fail('conflict', 'That action is already being undone.');
    cellar.deletedAt = new Date();
    await cellar.save();
    logAudit(ctx.req, 'cellar.delete', { type: 'cellar', id: cellar._id, cellarId: cellar._id }, { via: 'undo' });
    return record({ summary: `Undid create — cellar "${cellar.name}" deleted`, data: { undone: 'create_cellar', cellar_id: String(cellar._id) } });
  }

  if (last.action === 'rack_create') {
    const rackId = last.detail?.rackId;
    const rack = await Rack.findOne({ _id: rackId, deletedAt: null });
    if (!rack) return fail('conflict', 'That rack no longer exists; nothing was changed.');
    const access = await resolveCellarAccess(ctx.user.id, rack.cellar, 'editor');
    if (!access) return fail('conflict', 'You no longer have access to that rack; nothing was changed.');
    if ((rack.slots || []).length) {
      return fail('conflict', 'That rack now holds bottles — clear it in the web app before deleting it. Nothing was changed.');
    }
    if (!(await claim(last))) return fail('conflict', 'That action is already being undone.');
    rack.deletedAt = new Date();
    await rack.save();
    logAudit(ctx.req, 'rack.delete', { type: 'rack', id: rack._id, cellarId: rack.cellar }, { via: 'undo' });
    return record({ summary: `Undid create — rack "${rack.name}" deleted`, data: { undone: 'create_rack', rack_id: String(rack._id) } });
  }

  if (last.action === 'place') {
    // Reverse = clear the slot, but only if it STILL holds the placed bottle
    // (the user may have moved it since). We do not restore any bottle that was
    // displaced by the original place — it was already unracked then.
    const rack = await Rack.findOne({ _id: last.detail?.rackId, deletedAt: null });
    if (!rack) return fail('conflict', 'That rack no longer exists; nothing was changed.');
    const access = await resolveCellarAccess(ctx.user.id, rack.cellar, 'editor');
    if (!access) return fail('conflict', 'You no longer have access to that rack; nothing was changed.');
    const slot = rack.slots.find((s) => s.position === last.detail?.position);
    if (!slot || String(slot.bottle) !== String(last.bottle)) {
      // Someone changed the slot since — claim and no-op rather than clobber.
      if (!(await claim(last))) return fail('conflict', 'That action is already being undone.');
      return record({ summary: 'That slot has changed since; nothing to undo.', data: { undone: 'place_bottle', cleared: false } });
    }
    if (!(await claim(last))) return fail('conflict', 'That action is already being undone.');
    const result = await clearRackSlot(rack, last.detail.position, ctx.req);
    if (result.error) return fail('conflict', `Cannot undo that placement: ${result.error.message}`);
    return record({ summary: `Undid placement — position ${last.detail.position} cleared`, data: { undone: 'place_bottle', cleared: true } });
  }

  if (last.action === 'unplace') {
    // Reverse = put the bottle back in its old slot, if the position is free.
    const rack = await Rack.findOne({ _id: last.detail?.rackId, deletedAt: null });
    if (!rack) return fail('conflict', 'That rack no longer exists; nothing was changed.');
    const access = await resolveCellarAccess(ctx.user.id, rack.cellar, 'editor');
    if (!access) return fail('conflict', 'You no longer have access to that rack; nothing was changed.');
    const bottleId = last.detail?.bottleId || last.bottle;
    if (!bottleId) return fail('conflict', 'That slot was already empty; nothing to undo.');
    const pos = last.detail?.position;
    // Verify EVERYTHING before claiming (the move branch's discipline), so a
    // reversal that would fail doesn't burn the ledger row:
    //  - the bottle must still be active (grand-audit M2: without this, a
    //    bottle consumed via the web since the unplace would be re-slotted,
    //    breaking "consume frees the slot" — dead bottle in fill counts/3D);
    //  - it must still live in this rack's cellar;
    //  - the position must still exist (rack resized smaller since — the
    //    previously-computed-but-unused maxPos check);
    //  - the slot must be free.
    const bottle = await Bottle.findById(bottleId);
    if (!bottle) return fail('conflict', 'That bottle no longer exists; nothing was changed.');
    if (bottle.status !== 'active') {
      return fail('conflict', 'That bottle has been consumed since; nothing was changed.');
    }
    if (String(bottle.cellar) !== String(rack.cellar)) {
      return fail('conflict', 'That bottle is no longer in this rack\'s cellar; nothing was changed.');
    }
    if (pos > getMaxPosition(rack)) {
      return fail('conflict', 'That rack was resized and the slot no longer exists; nothing was changed.');
    }
    const occupied = rack.slots.find((s) => s.position === pos && String(s.bottle) !== String(bottleId));
    if (occupied) return fail('conflict', `Position ${pos} is occupied again; cannot restore. Nothing was changed.`);
    if (!(await claim(last))) return fail('conflict', 'That action is already being undone.');
    const result = await placeBottleInRack(rack, pos, bottleId, ctx.req);
    if (result.error) return fail('conflict', `Cannot undo that removal: ${result.error.message}`);
    return record({ summary: `Undid removal — bottle back in position ${pos}`, data: { undone: 'unplace_bottle', position: pos } });
  }

  if (last.action === 'arrange') {
    // Reverse = restore the pre-arrange slot assignment, but only while the
    // rack still holds EXACTLY the applied arrangement — any placement or move
    // since means restoring the snapshot would clobber newer intent.
    const rack = await Rack.findOne({ _id: last.detail?.rackId, deletedAt: null });
    if (!rack) return fail('conflict', 'That rack no longer exists; nothing was changed.');
    const access = await resolveCellarAccess(ctx.user.id, rack.cellar, 'editor');
    if (!access) return fail('conflict', 'You no longer have access to that rack; nothing was changed.');
    const before = last.prev?.before;
    const target = last.detail?.target;
    if (!Array.isArray(before) || !Array.isArray(target)) {
      return fail('conflict', 'That arrangement has no recorded previous layout; nothing was changed.');
    }
    const current = (rack.slots || [])
      .filter((s) => s.bottle)
      .map((s) => ({ position: s.position, bottleId: String(s.bottle) }))
      .sort((a, b) => a.position - b.position);
    const sortedTarget = [...target].sort((a, b) => a.position - b.position);
    const matches = current.length === sortedTarget.length &&
      current.every((x, i) => x.position === sortedTarget[i].position && x.bottleId === String(sortedTarget[i].bottleId));
    if (!matches) {
      return fail('conflict', 'The rack has changed since that arrangement; undo it manually. Nothing was changed.');
    }
    if (!(await claim(last))) return fail('conflict', 'That action is already being undone.');
    // Same shared one-save apply the arrangement itself used (rackOps).
    const { applyArrangement } = require('../services/rackOps');
    const applied = await applyArrangement(rack, before, ctx.req, { via: 'undo', restored: before.length });
    if (applied.error) return fail('conflict', `${applied.error.message} Nothing was restored.`);
    return record({
      summary: `Undid arrangement — rack "${rack.name}" restored to its previous layout`,
      data: { undone: 'auto_arrange', rack_id: String(rack._id), bottles: before.length },
    });
  }

  if (last.action === 'move') {
    // Reverse = move the bottle back to its origin cellar (must still be owned
    // and the bottle still active). Arrives unplaced, same as any move.
    const fromId = last.detail?.fromCellarId;
    const access = await resolveBottleAccess(ctx.user.id, last.bottle, 'owner');
    if (!access) return fail('conflict', 'That bottle is no longer accessible; nothing was changed.');
    if (String(access.bottle.cellar) !== String(last.detail?.toCellarId)) {
      return fail('conflict', 'That bottle has moved again since; undo it manually. Nothing was changed.');
    }
    // Verify move-ability BEFORE claiming the ledger row, so a bottle consumed
    // since the move doesn't burn the row on a reversal that would fail anyway.
    if (access.bottle.status !== 'active') {
      return fail('conflict', 'That bottle has been consumed since the move; nothing was changed.');
    }
    const origin = await Cellar.findOne({ _id: fromId, user: ctx.user.id, deletedAt: null });
    if (!origin) return fail('conflict', 'The origin cellar is gone or no longer yours; nothing was changed.');
    if (!(await claim(last))) return fail('conflict', 'That action is already being undone.');
    const bottle = await Bottle.findById(access.bottle._id);
    const result = await moveBottleToCellar(bottle, access.cellar, origin, ctx.req);
    if (result.error) return fail('conflict', `Cannot undo that move: ${result.error.message}`);
    return record({ summary: `Undid move — bottle back in "${origin.name}" (unplaced)`, data: { undone: 'move_bottle', cellar_id: String(origin._id) } });
  }

  return fail('conflict', 'Unrecognised action; nothing was changed.');
}

module.exports = { undoStructural };
