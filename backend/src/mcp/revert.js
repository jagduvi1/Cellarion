// Shared reversal engine for MCP mutations. undo_last (the MCP tool, reverses
// the NEWEST) and the in-app "Recent AI activity" timeline (reverts a SPECIFIC
// row the user clicked) both go through revertLedgerRow, so the reversal logic
// — access re-checks, atomic claims, prev-snapshot restores — lives once.
//
// Every reversal re-verifies current state and refuses (conflict) if the world
// moved on since the action; nothing here trusts that `row` is the newest.
const McpActionLog = require('../models/McpActionLog');
const { CONSUMED_STATUSES } = require('../config/constants');
const { consumeBottle, restoreBottle, RESTORE_WINDOW_MS } = require('../services/bottleOps');
const { logAction } = require('./actionLedger');
const { resolveBottleAccess } = require('./toolUtil');

// Actions a caller may reverse given their scopes. Reversing a write-class
// action needs the write grant (a consume-only token must never gain
// delete-a-bottle power through undo).
const CONSUME_REVERSIBLE = ['consume', 'restore'];
const WRITE_REVERSIBLE = ['add', 'update', 'bulk_add', 'somm_maturity', 'somm_price',
  'cellar_create', 'rack_create', 'place', 'unplace', 'move'];

function reversibleActionsFor(scopes) {
  return (scopes || []).includes('write') ? [...CONSUME_REVERSIBLE, ...WRITE_REVERSIBLE] : CONSUME_REVERSIBLE;
}

const bottleLabel = (b) => `bottle ${b._id} (vintage ${b.vintage})`;

/**
 * Reverse ONE ledger row. `row` must already be the caller's, un-reversed, not
 * a viaUndo record, and within the window (the callers enforce that when they
 * pick it). helpers = { ok, fail } envelope builders (tool vs REST supply
 * their own). Returns whatever ok/fail return.
 */
async function revertLedgerRow(row, ctx, { ok, fail }) {
  // Structural (cellar/rack create, placement, move) — bespoke, no single bottle.
  if (['cellar_create', 'rack_create', 'place', 'unplace', 'move'].includes(row.action)) {
    const { undoStructural } = require('./structuralUndo');
    return undoStructural(row, ctx, { ok, fail, logAction });
  }

  // Somm curation — registry data, role re-checked.
  if (row.action === 'somm_maturity' || row.action === 'somm_price') {
    const roles = ctx.user?.roles || [];
    if (!roles.includes('somm') && !roles.includes('admin')) {
      return fail('forbidden_scope', 'Undoing sommelier curation needs the sommelier (or admin) role.');
    }
    let profile = null;
    if (row.action === 'somm_maturity') {
      const WineVintageProfile = require('../models/WineVintageProfile');
      profile = await WineVintageProfile.findById(row.detail?.profileId);
      if (!profile) return fail('conflict', 'That maturity profile no longer exists; nothing was changed.');
    }
    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

    let envelope;
    if (row.action === 'somm_price') {
      const WineVintagePrice = require('../models/WineVintagePrice');
      const del = await WineVintagePrice.deleteOne({ _id: row.detail?.entryId, setBy: ctx.user.id });
      envelope = { summary: del.deletedCount ? `Undid price entry — snapshot for vintage ${row.detail?.vintage} removed` : 'Price snapshot was already gone; ledger marked undone.', data: { undone: 'set_vintage_price', removed: !!del.deletedCount } };
    } else {
      const prev = row.prev || {};
      for (const f of ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil']) {
        profile[f] = prev[f] === null || prev[f] === undefined ? undefined : prev[f];
      }
      profile.sommNotes = prev.sommNotes === null ? undefined : prev.sommNotes;
      profile.status = prev.status || 'pending';
      profile.relative = !!prev.relative;
      profile.setBy = prev.setBy || null;
      profile.setAt = prev.setAt || null;
      await profile.save();
      envelope = { summary: `Undid maturity review — vintage ${row.detail?.vintage} back to ${profile.status}`, data: { undone: 'set_vintage_maturity', profile_id: String(profile._id), status: profile.status } };
    }
    await logAction(ctx, { tool: 'undo_last', action: row.action, viaUndo: true, detail: { undid: String(row._id) }, result: envelope });
    return ok(envelope.summary, envelope.data);
  }

  // Bulk add — many bottles, all-or-nothing pre-verify then claim.
  if (row.action === 'bulk_add') {
    const { removeBottleCascade } = require('../services/bottleOps');
    const ids = row.detail?.bottles || [];
    if (!ids.length) return fail('conflict', 'That bulk add recorded no bottles; nothing to undo.');
    const resolved = [];
    for (const id of ids) {
      const a = await resolveBottleAccess(ctx.user.id, id, 'editor');
      if (!a) return fail('conflict', `Bottle ${id} from that batch is no longer accessible; nothing was changed.`);
      if (a.bottle.status !== 'active') return fail('conflict', `Bottle ${id} from that batch has been ${a.bottle.status} since; undo it individually first. Nothing was changed.`);
      resolved.push(a.bottle);
    }
    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That batch is already being undone by another request.');
    const removed = [];
    const failures = [];
    for (const b of resolved) {
      try {
        const r = await removeBottleCascade(b, ctx.req, 'bottle.undo');
        if (r.error) failures.push({ bottle_id: String(b._id), error: r.error.message });
        else removed.push(String(b._id));
      } catch (err) { failures.push({ bottle_id: String(b._id), error: err.message }); }
    }
    const envelope = { summary: `Undid bulk add — ${removed.length} bottle(s) removed${failures.length ? `, ${failures.length} FAILED (remove those manually)` : ''}`, data: { undone: 'bulk_add', removed_bottle_ids: removed, ...(failures.length ? { failures } : {}) } };
    await logAction(ctx, { tool: 'undo_last', action: 'undo_add', viaUndo: true, cellar: row.cellar, detail: { undid: String(row._id), count: resolved.length }, result: envelope });
    return ok(envelope.summary, envelope.data);
  }

  // Bottle-centric: consume / restore / add / update.
  const access = await resolveBottleAccess(ctx.user.id, row.bottle, 'editor');
  if (!access) return fail('conflict', 'The bottle from that action is no longer accessible; nothing was changed.');
  const { bottle } = access;

  let envelope;
  let reverseEntry;
  if (row.action === 'add') {
    const { removeBottleCascade } = require('../services/bottleOps');
    const result = await removeBottleCascade(bottle, ctx.req, 'bottle.undo');
    if (result.error) return fail('conflict', `Cannot undo that add: ${result.error.message} Nothing was changed.`);
    envelope = { summary: `Undid add — ${bottleLabel(bottle)} removed from the cellar`, data: { undone: 'add_bottle', bottle_id: bottle._id } };
    reverseEntry = { action: 'undo_add', prev: null };
  } else if (row.action === 'update') {
    const { updateBottleFields } = require('../services/bottleOps');
    const prevFields = row.prev || {};
    if (Object.keys(prevFields).length === 0) return fail('conflict', 'That update has no recorded previous values; nothing was changed.');
    const result = await updateBottleFields(bottle, prevFields, ctx.req);
    if (result.error) return fail('conflict', `Cannot undo that update: ${result.error.message}`);
    envelope = { summary: `Undid update on ${bottleLabel(bottle)} — restored: ${Object.keys(prevFields).join(', ')}`, data: { undone: 'update_bottle', bottle_id: bottle._id, restored: result.changes } };
    reverseEntry = { action: 'update', prev: result.prev };
  } else if (row.action === 'consume') {
    const prevSnapshot = { reason: bottle.consumedReason || bottle.status, note: bottle.consumedNote, rating: bottle.consumedRating, ratingScale: bottle.consumedRatingScale };
    const result = await restoreBottle(bottle, ctx.req);
    if (result.error) return fail('conflict', `Cannot undo that consume: ${result.error.message}`);
    envelope = { summary: `Undid consume — ${bottleLabel(bottle)} is back in the cellar (unplaced)`, data: { undone: 'consume_bottle', bottle_id: bottle._id, status: 'active' } };
    reverseEntry = { action: 'restore', prev: prevSnapshot };
  } else { // restore
    if (CONSUMED_STATUSES.includes(bottle.status)) {
      return fail('conflict', 'That restore cannot be undone: the bottle has been consumed again since. Nothing was changed.');
    }
    const prev = row.prev || {};
    const result = await consumeBottle(bottle, { reason: prev.reason || 'drank', note: prev.note, rating: prev.rating, ratingScale: prev.ratingScale }, ctx.req);
    if (result.error) return fail('conflict', `Cannot undo that restore: ${result.error.message}`);
    envelope = { summary: `Undid restore — ${bottleLabel(bottle)} is consumed again (${bottle.status})`, data: { undone: 'restore_bottle', bottle_id: bottle._id, status: bottle.status } };
    reverseEntry = { action: 'consume', prev: null };
  }

  // Claim + record. The reversal already happened above; on the rare race where
  // another request reversed the row first, the mutation is idempotent-ish
  // (re-removing/re-restoring a bottle already in that state is a no-op-conflict
  // the reversal fns guard), and the second logAction is harmless bookkeeping.
  const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  if (!claimed) return fail('conflict', 'That action was just reversed by another request.');
  await logAction(ctx, { tool: 'undo_last', ...reverseEntry, viaUndo: true, bottle: bottle._id, cellar: bottle.cellar, detail: { undid: String(row._id) }, result: envelope });
  return ok(envelope.summary, envelope.data);
}

/** Find + reverse the caller's newest reversible un-reversed action (undo_last). */
async function revertLatest(ctx, helpers) {
  const row = await McpActionLog.findOne({
    user: ctx.user.id,
    reversed: false,
    viaUndo: { $ne: true },
    action: { $in: reversibleActionsFor(ctx.scopes) },
    createdAt: { $gte: new Date(Date.now() - RESTORE_WINDOW_MS) },
  }).sort({ createdAt: -1 });
  if (!row) return helpers.fail('not_found', 'No recent MCP action to undo — nothing has been changed through MCP in the last few days.');
  return revertLedgerRow(row, ctx, helpers);
}

module.exports = { revertLedgerRow, revertLatest, reversibleActionsFor, WRITE_REVERSIBLE, CONSUME_REVERSIBLE };
