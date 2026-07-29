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
// Release a claim made before a mutation that then failed, so the ledger row
// stays un-reversed and the undo can be retried (grand-audit M1: claiming
// reversed:true and then hitting a VersionError on save() left the row marked
// undone while nothing was actually restored — the retry then found nothing).
// The idempotencyKey was nulled at claim time and stays null; that only means
// the ORIGINAL action can't idempotency-replay, which is fine — it already ran.
async function unclaim(rowId) {
  await McpActionLog.updateOne({ _id: rowId }, { $set: { reversed: false } }).catch(() => {});
}

const CONSUME_REVERSIBLE = ['consume', 'restore'];
const WRITE_REVERSIBLE = ['add', 'update', 'bulk_add', 'somm_maturity', 'somm_maturity_defer',
  'somm_wine_profile', 'somm_price',
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

    // Occasion rows (detail.bottles) — ONE entry, ratings on several bottles.
    // Access is re-checked for every bottle whose rating would be restored;
    // the entry itself is the caller's own, so bottles that got no rating
    // don't gate the undo (unlike the single-bottle path below, where the one
    // bottle IS the action).
    if (Array.isArray(row.detail?.bottles)) {
      const ratings = row.prev?.ratings || [];
      const restorable = [];
      for (const r of ratings) {
        const a = await resolveBottleAccess(ctx.user.id, r.bottle, 'editor');
        if (!a) return fail('conflict', `Bottle ${r.bottle} from that note is no longer accessible; nothing was changed.`);
        restorable.push({ r, bottle: a.bottle });
      }
      const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
      if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

      let del;
      try {
        del = await deleteEntry(ctx.user.id, row.detail?.journalId, ctx.req, { auditMeta: { via: 'undo' } });
      } catch (err) {
        await unclaim(row._id); // nothing restored yet → let the undo be retried
        if (err?.name === 'VersionError') return fail('conflict', 'The journal entry changed mid-undo — retry.');
        throw err;
      }
      let restored = 0; let skipped = 0; let failed = 0;
      for (const { r, bottle } of restorable) {
        // Same changed-since guard as the single-bottle path: only restore
        // while the bottle still carries the rating THIS action set (r.set).
        const current = r.field === 'rating'
          ? { value: bottle.rating ?? null, scale: bottle.ratingScale || '5' }
          : { value: bottle.consumedRating ?? null, scale: bottle.consumedRatingScale || '5' };
        if (r.set && (current.value !== r.set.value || current.scale !== r.set.scale)) { skipped += 1; continue; }
        if (r.field === 'rating') {
          const { updateBottleFields } = require('../services/bottleOps');
          const result = await updateBottleFields(bottle, { rating: r.rating, ratingScale: r.ratingScale || undefined }, ctx.req);
          if (result.error) failed += 1; else restored += 1;
        } else {
          try {
            bottle.consumedRating = r.consumedRating ?? undefined;
            bottle.consumedRatingScale = r.consumedRatingScale || undefined;
            await bottle.save();
            restored += 1;
          } catch {
            failed += 1; // a throw counts like a returned error → honest ratings_failed report
          }
        }
      }
      const parts = [];
      if (restored) parts.push(`${restored} rating(s) restored`);
      if (skipped) parts.push(`${skipped} rating(s) left as-is (changed again since)`);
      if (failed) parts.push(`${failed} rating(s) could NOT be restored`);
      const envelope = {
        summary: `Undid tasting note (${row.detail.count || row.detail.bottles.length} wines)${del.deleted ? ' — journal entry removed' : ' — entry was already gone'}${parts.length ? `, ${parts.join(', ')}` : ''}`,
        data: { undone: 'capture_tasting_note', entry_removed: !!del.deleted, ratings_restored: restored, ratings_skipped: skipped, ...(failed ? { ratings_failed: failed } : {}) },
      };
      await logAction(ctx, { tool: 'undo_last', action: 'tasting_note', viaUndo: true, cellar: row.cellar, detail: { undid: String(row._id) }, result: envelope });
      return ok(envelope.summary, envelope.data);
    }

    const access = await resolveBottleAccess(ctx.user.id, row.bottle, 'editor');
    if (!access) return fail('conflict', 'The bottle from that note is no longer accessible; nothing was changed.');
    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

    let del;
    try {
      del = await deleteEntry(ctx.user.id, row.detail?.journalId, ctx.req, { auditMeta: { via: 'undo' } });
    } catch (err) {
      await unclaim(row._id); // nothing restored yet → let the undo be retried
      if (err?.name === 'VersionError') return fail('conflict', 'The journal entry changed mid-undo — retry.');
      throw err;
    }
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
        try {
          bottle.consumedRating = row.prev.consumedRating ?? undefined;
          bottle.consumedRatingScale = row.prev.consumedRatingScale || undefined;
          await bottle.save();
          ratingRestored = true;
        } catch { /* stays false → reported as "rating could NOT be restored" */ }
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
          await unclaim(row._id); // failed → let the undo be retried
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
      await unclaim(row._id); // failed → let the undo be retried
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

  // Somm curation of a wine's tasting profile — restores the previous values
  // AND the previous provenance, so undoing a correction hands the row back to
  // the AI enrichment job exactly as it was (source 'ai' → eligible again).
  if (row.action === 'somm_wine_profile') {
    const roles = ctx.user?.roles || [];
    if (!roles.includes('somm') && !roles.includes('admin')) {
      return fail('forbidden_scope', 'Undoing sommelier curation needs the sommelier (or admin) role.');
    }
    const WineDefinition = require('../models/WineDefinition');
    const { restoreProfile } = require('../services/wineProfileOps');
    const wine = await WineDefinition.findById(row.detail?.wineId);
    if (!wine) return fail('conflict', 'That wine no longer exists; nothing to undo.');

    // Claim before mutating, like every other branch here: without it the row
    // stays un-reversed, so undo_last keeps selecting the same edit forever and
    // a concurrent twin can restore the same snapshot twice.
    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

    restoreProfile(wine, row.prev || {});
    try {
      await wine.save();
    } catch (err) {
      await unclaim(row._id); // failed → let the undo be retried
      if (err?.name === 'VersionError') return fail('conflict', 'The wine changed mid-undo — retry.');
      throw err;
    }
    require('../services/search').indexWine(wine._id).catch(() => {});

    const envelope = {
      summary: `Undid tasting-profile edit — ${wine.producer} — ${wine.name} back to ${wine.aiProfile?.source || 'ai'}-sourced`,
      data: { undone: 'set_wine_profile', wine_id: String(wine._id), source: wine.aiProfile?.source || 'ai' },
    };
    await logAction(ctx, { tool: 'undo_last', action: row.action, viaUndo: true, detail: { undid: String(row._id) }, result: envelope });
    return ok(envelope.summary, envelope.data);
  }

  // Somm deferral — puts the pair back exactly as it was, including a PREVIOUS
  // deferral (a re-defer with a new date undoes to the old one, not to pending).
  if (row.action === 'somm_maturity_defer') {
    const roles = ctx.user?.roles || [];
    if (!roles.includes('somm') && !roles.includes('admin')) {
      return fail('forbidden_scope', 'Undoing sommelier curation needs the sommelier (or admin) role.');
    }
    const WineVintageProfile = require('../models/WineVintageProfile');
    const { restoreDeferral } = require('../services/maturityOps');
    const profile = await WineVintageProfile.findById(row.detail?.profileId);
    if (!profile) return fail('conflict', 'That maturity profile no longer exists; nothing was changed.');

    const claimed = await McpActionLog.findOneAndUpdate({ _id: row._id, reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    if (!claimed) return fail('conflict', 'That action is already being undone by another request.');

    restoreDeferral(profile, row.prev || {});
    try {
      await profile.save();
    } catch (err) {
      await unclaim(row._id); // failed → let the undo be retried
      if (err?.name === 'VersionError') return fail('conflict', 'The profile changed mid-undo — retry.');
      throw err;
    }

    const envelope = {
      summary: `Undid deferral — vintage ${row.detail?.vintage} back to ${profile.status}`,
      data: { undone: 'defer_vintage_maturity', profile_id: String(profile._id), status: profile.status },
    };
    await logAction(ctx, { tool: 'undo_last', action: row.action, viaUndo: true, detail: { undid: String(row._id) }, result: envelope });
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
      try {
        await profile.save();
      } catch (err) {
        await unclaim(row._id); // failed → let the undo be retried (was unguarded, M1 class)
        if (err?.name === 'VersionError') return fail('conflict', 'The profile changed mid-undo — retry.');
        throw err;
      }
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
    // A batch that MINTED registry wines rolls them back too, when nothing
    // else references them (the launch-day orphaned-wine + pending-maturity-
    // profile report). Conservative guards + best-effort in registryGc.
    const winesRemoved = [];
    if (!failures.length && Array.isArray(row.detail?.createdWineIds)) {
      const { gcOrphanMintedWine } = require('../services/registryGc');
      for (const wid of row.detail.createdWineIds) {
        const gc = await gcOrphanMintedWine(wid, ctx.req);
        if (gc.removed) winesRemoved.push(String(wid));
      }
    }
    const envelope = { summary: `Undid bulk add — ${removed.length} bottle(s) removed${winesRemoved.length ? `, ${winesRemoved.length} newly-created registry wine(s) rolled back` : ''}${failures.length ? `, ${failures.length} FAILED (remove those manually)` : ''}`, data: { undone: 'bulk_add', removed_bottle_ids: removed, ...(winesRemoved.length ? { removed_wine_ids: winesRemoved } : {}), ...(failures.length ? { failures } : {}) } };
    await logAction(ctx, { tool: 'undo_last', action: 'undo_add', viaUndo: true, cellar: row.cellar, detail: { undid: String(row._id), count: resolved.length, ...(winesRemoved.length ? { winesRemoved } : {}) }, result: envelope });
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
    // If THIS add minted the registry wine (detail.wine_created), roll the
    // wine + its seeded maturity profile back too when nothing else uses it.
    let wineRolledBack = false;
    if (row.detail?.wine_created && row.detail?.wine) {
      const { gcOrphanMintedWine } = require('../services/registryGc');
      wineRolledBack = (await gcOrphanMintedWine(row.detail.wine, ctx.req)).removed;
    }
    envelope = { summary: `Undid add — ${bottleLabel(bottle)} removed from the cellar${wineRolledBack ? ' (its newly-created registry wine was rolled back too)' : ''}`, data: { undone: 'add_bottle', bottle_id: bottle._id, ...(wineRolledBack ? { removed_wine_id: String(row.detail.wine) } : {}) } };
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
