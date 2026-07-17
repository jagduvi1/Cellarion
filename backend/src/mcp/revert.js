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
  'cellar_create', 'rack_create', 'place', 'unplace', 'move', 'arrange', 'tasting_note', 'attach_image',
  'winelist_add', 'winelist_price'];

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
  // Structural (cellar/rack create, placement, move, arrange) — bespoke, no single bottle.
  if (['cellar_create', 'rack_create', 'place', 'unplace', 'move', 'arrange'].includes(row.action)) {
    const { undoStructural } = require('./structuralUndo');
    return undoStructural(row, ctx, { ok, fail, logAction });
  }

  // Attach image — delete the BottleImage row (and its files) the tool created.
  // Access re-checked; only images NOT assigned to a shared registry wine are
  // removable (an attach never assigns, so this always holds for our own row).
  if (row.action === 'attach_image') {
    const BottleImage = require('../models/BottleImage');
    const { unlinkImageFiles } = require('../services/imageProcessor');
    const access = await resolveBottleAccess(ctx.user.id, row.bottle, 'editor');
    if (!access) return fail('conflict', 'The bottle from that photo is no longer accessible; nothing was changed.');
    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

    const image = await BottleImage.findOne({ _id: row.detail?.imageId, uploadedBy: ctx.user.id, assignedToWine: false });
    let removed = false;
    if (image) {
      try { await unlinkImageFiles(image); } catch { /* files may be gone; row removal is what matters */ }
      await BottleImage.deleteOne({ _id: image._id });
      removed = true;
    }
    const envelope = {
      summary: `Undid photo attach${removed ? ' — image removed' : ' — image was already gone'}`,
      data: { undone: 'attach_bottle_image', image_removed: removed },
    };
    await logAction(ctx, { tool: 'undo_last', action: 'attach_image', viaUndo: true, bottle: row.bottle, cellar: row.cellar, detail: { undid: String(row._id) }, result: envelope });
    return ok(envelope.summary, envelope.data);
  }

  // Tasting note — remove the journal entry (via the shared journalOps delete,
  // so the reversal is audited exactly like a manual deletion) and restore the
  // previous rating.
  if (row.action === 'tasting_note') {
    const { deleteEntry } = require('../services/journalOps');
    const access = await resolveBottleAccess(ctx.user.id, row.bottle, 'editor');
    if (!access) return fail('conflict', 'The bottle from that note is no longer accessible; nothing was changed.');
    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

    const del = await deleteEntry(ctx.user.id, row.detail?.journalId, ctx.req, { auditMeta: { via: 'undo' } });
    let ratingRestored = false;
    let ratingSkipped = false;
    if (row.prev && row.prev.field) {
      const { bottle } = access;
      // Changed-since guard: only restore the previous rating while the bottle
      // still carries the rating THIS action set (row.result records it). If
      // the user re-rated by hand since, their newer intent wins over the undo.
      const set = row.result?.data?.rating_recorded;
      const current = row.prev.field === 'rating'
        ? { value: bottle.rating ?? null, scale: bottle.ratingScale || '5' }
        : { value: bottle.consumedRating ?? null, scale: bottle.consumedRatingScale || '5' };
      if (set && (current.value !== set.value || current.scale !== set.scale)) {
        ratingSkipped = true;
      } else if (row.prev.field === 'rating') {
        const { updateBottleFields } = require('../services/bottleOps');
        const result = await updateBottleFields(bottle, { rating: row.prev.rating, ratingScale: row.prev.ratingScale || undefined }, ctx.req);
        ratingRestored = !result.error;
      } else {
        bottle.consumedRating = row.prev.consumedRating ?? undefined;
        bottle.consumedRatingScale = row.prev.consumedRatingScale || undefined;
        await bottle.save();
        ratingRestored = true;
      }
    }
    const ratingNote = !row.prev?.field ? ''
      : ratingSkipped ? ', rating left as-is (it was changed again since)'
        : ratingRestored ? ', previous rating restored' : ', rating could NOT be restored';
    const envelope = {
      summary: `Undid tasting note${del.deleted ? ' — journal entry removed' : ' — entry was already gone'}${ratingNote}`,
      data: { undone: 'capture_tasting_note', entry_removed: !!del.deleted, rating_restored: row.prev?.field ? ratingRestored : undefined },
    };
    await logAction(ctx, { tool: 'undo_last', action: 'tasting_note', viaUndo: true, bottle: row.bottle, cellar: row.cellar, detail: { undid: String(row._id) }, result: envelope });
    return ok(envelope.summary, envelope.data);
  }

  // Wine-list curation — entry add/pricing on the caller's own list. The list
  // is re-loaded user-scoped; the entry is located by the wine+vintage+size
  // key recorded in detail (entries have no _id).
  if (row.action === 'winelist_add' || row.action === 'winelist_price') {
    const WineList = require('../models/WineList');
    const d = row.detail || {};
    const list = await WineList.findOne({ _id: d.listId, user: ctx.user.id });

    const matches = (e) => String(e.wine) === String(d.wineId)
      && (e.vintage || 'NV') === (d.vintage || 'NV')
      && (e.bottleSize || '750ml') === (d.bottleSize || '750ml');
    const containers = list
      ? [...(list.sections || []).map((s) => s.entries), list.autoGroupEntries || []]
      : [];

    if (row.action === 'winelist_add') {
      // Missing list or entry → the added line is already gone; claiming the
      // row as reversed is the honest terminal state (same as attach_image).
      const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
      if (!claimed) return fail('conflict', 'That action is already being undone by another request.');
      let removed = false;
      for (const entries of containers) {
        const i = entries.findIndex(matches);
        if (i !== -1) { entries.splice(i, 1); removed = true; break; }
      }
      if (removed) {
        try {
          await list.save();
        } catch (err) {
          if (err?.name === 'VersionError') return fail('conflict', 'The list changed mid-undo — retry.');
          throw err;
        }
      }
      const envelope = {
        summary: `Undid add to "${d.listName || 'wine list'}"${removed ? ' — entry removed' : ' — entry was already gone'}`,
        data: { undone: 'add_to_list', list_id: d.listId, entry_removed: removed },
      };
      await logAction(ctx, { tool: 'undo_last', action: 'winelist_add', viaUndo: true, cellar: row.cellar, detail: { undid: String(row._id) }, result: envelope });
      return ok(envelope.summary, envelope.data);
    }

    // winelist_price — restore the prev pricing snapshot; if the list or the
    // entry is gone there is nothing to restore onto.
    let entry = null;
    for (const entries of containers) {
      entry = entries.find(matches) || entry;
    }
    if (!entry) return fail('conflict', 'That wine-list entry no longer exists; nothing was changed.');
    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That action is already being undone by another request.');
    const prev = row.prev || {};
    entry.listPrice = prev.listPrice === null || prev.listPrice === undefined ? undefined : prev.listPrice;
    entry.byGlass = !!prev.byGlass;
    entry.glassPrice = prev.glassPrice === null || prev.glassPrice === undefined ? undefined : prev.glassPrice;
    entry.glassPriceManual = !!prev.glassPriceManual;
    try {
      await list.save();
    } catch (err) {
      if (err?.name === 'VersionError') return fail('conflict', 'The list changed mid-undo — retry.');
      throw err;
    }
    const envelope = {
      summary: `Undid pricing change on "${d.listName || 'wine list'}" — previous prices restored`,
      data: { undone: 'update_list_pricing', list_id: d.listId, restored: prev },
    };
    await logAction(ctx, { tool: 'undo_last', action: 'winelist_price', viaUndo: true, cellar: row.cellar, detail: { undid: String(row._id) }, result: envelope });
    return ok(envelope.summary, envelope.data);
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
