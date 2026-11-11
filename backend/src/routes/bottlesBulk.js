// A cellar's "Recently deleted" and the bulk actions on bottles:
//   GET  /api/bottles/trash          POST /api/bottles/trash/restore
//   POST /api/bottles/bulk-move      POST /api/bottles/bulk-delete
//   POST /api/bottles/bulk
// Mounted by routes/bottles.js after its requireAuth and idempotency
// middleware, so every handler here runs behind both.

const express = require('express');
const { ROLE_LEVELS } = require('../middleware/bottleAccess');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { getCellarRole } = require('../utils/cellarAccess');
const { isReserved } = require('../utils/reservationUtils');
const { logAudit } = require('../services/audit');
const { CONSUMED_STATUSES, ORDERED_STATUS } = require('../config/constants');
const { parseCurrency, normalizeCurrency, isSupportedCurrency } = require('../config/currencies');
const mongoose = require('mongoose');
const { updateBottleFields, consumeBottle, restoreBottle, markArrived } = require('../services/bottleOps');
const { parseExpectedArrival } = require('../utils/onOrder');
const { moveBottleToCellar } = require('../services/rackOps');
const DeletedBottle = require('../models/DeletedBottle');
const { TRASH_DAYS, trashBottle, restoreTrashed } = require('../services/bottleTrash');

const router = express.Router();

// "Recently deleted" lists at most this many bottles per cellar.
const TRASH_LIST_MAX = 2000;

// ── Recently deleted (services/bottleTrash) ──────────────────────────────
// routes/bottles.js mounts this router BEFORE its /:id routes: Express would
// otherwise read "trash" as a bottle id (GET /:id, POST /:id/restore). Both
// routes below act on ONE cellar the caller
// can edit — the same role a bulk delete needs — and a cellar they can't
// reads as not found, as everywhere else.
async function editableCellar(req, cellarId) {
  if (!cellarId || !mongoose.isValidObjectId(String(cellarId))) {
    return { error: { status: 400, message: 'A valid cellar id is required' } };
  }
  const cellar = await Cellar.findById(String(cellarId));
  const role = cellar && !cellar.deletedAt ? getCellarRole(cellar, req.user.id) : null;
  if (!role || (ROLE_LEVELS[role] || 0) < ROLE_LEVELS.editor) {
    return { error: { status: 404, message: 'Cellar not found' } };
  }
  return { cellar };
}

// GET /api/bottles/trash?cellar=<id> - the cellar's "Recently deleted",
// newest first. The stored snapshots never leave the server.
// Response: { items: [{ id, batchId, deletedAt, purgeAt, label }], retentionDays }
router.get('/trash', async (req, res) => {
  try {
    const found = await editableCellar(req, req.query.cellar);
    if (found.error) return res.status(found.error.status).json({ error: found.error.message });
    const rows = await DeletedBottle.find({ cellar: found.cellar._id })
      .sort({ deletedAt: -1, _id: 1 })
      .limit(TRASH_LIST_MAX)
      .select('batchId deletedAt purgeAt label')
      .lean();
    res.json({
      items: rows.map((r) => ({ id: r._id, batchId: r.batchId, deletedAt: r.deletedAt, purgeAt: r.purgeAt, label: r.label })),
      retentionDays: TRASH_DAYS,
    });
  } catch (error) {
    console.error('List recently deleted error:', error);
    res.status(500).json({ error: 'Failed to load recently deleted bottles' });
  }
});

// POST /api/bottles/trash/restore - bring bottles back from "Recently deleted".
// Body: { cellar, ids?: string[] (trash row ids), batchId?: string } — ids,
// a whole batch (the Undo after a bulk delete, "Restore all"), or both.
// Each bottle returns under its old id and re-takes its rack slot if free.
// Response: { restored, restoredIds: string[] (bottle ids), placed, skipped: [{ id, reason }] }
//   reason ∈ 'cellar_gone', 'wine_gone', 'exists', 'error'
router.post('/trash/restore', async (req, res) => {
  try {
    const { cellar: cellarId, ids, batchId } = req.body || {};
    const found = await editableCellar(req, cellarId);
    if (found.error) return res.status(found.error.status).json({ error: found.error.message });
    const idList = Array.isArray(ids) ? ids : [];
    if (idList.length > BULK_MAX) {
      return res.status(400).json({ error: `At most ${BULK_MAX} bottles per request` });
    }
    if (!idList.every((x) => typeof x === 'string' && mongoose.isValidObjectId(x))) {
      return res.status(400).json({ error: 'ids must be valid ids' });
    }
    const hasBatch = typeof batchId === 'string' && mongoose.isValidObjectId(batchId);
    if (idList.length === 0 && !hasBatch) {
      return res.status(400).json({ error: 'Give the ids to restore, or a batchId' });
    }
    const or = [];
    if (idList.length) or.push({ _id: { $in: idList.map((x) => new mongoose.Types.ObjectId(x)) } });
    if (hasBatch) or.push({ batchId: new mongoose.Types.ObjectId(batchId) });
    const rows = await DeletedBottle.find({ cellar: found.cellar._id, $or: or }).sort({ deletedAt: 1, _id: 1 }).limit(BULK_MAX);

    const restoredIds = [];
    const skipped = [];
    let placed = 0;
    for (const row of rows) {
      let result;
      try {
        result = await restoreTrashed(row, req);
      } catch (err) {
        console.error(`Restore from trash: row ${row._id} failed:`, err.message);
        result = { error: { code: 'error' } };
      }
      if (result.error) { skipped.push({ id: String(row._id), reason: result.error.code || 'error' }); continue; }
      restoredIds.push(String(row.bottleId));
      if (result.placed) placed += 1;
    }
    logAudit(req, 'bottle.bulk_restore',
      { type: 'cellar', id: found.cellar._id, cellarId: found.cellar._id },
      { requested: rows.length, restored: restoredIds.length, skipped: skipped.length, ...(hasBatch ? { batchId } : {}) });
    res.json({ restored: restoredIds.length, restoredIds, placed, skipped });
  } catch (error) {
    console.error('Restore recently deleted error:', error);
    res.status(500).json({ error: 'Failed to restore the bottles' });
  }
});

// ── Bulk actions ────────────────────────────────────────────────────────────
// A delivery of many bottles logged in one cellar may need to move, be edited
// or be consumed together. The cellar view has a select mode, and these routes
// are what it calls. Every bulk route applies the SAME per-bottle operation the single
// routes use (services/rackOps, services/bottleOps), one bottle at a time, and
// reports partial success instead of hiding it: each bottle that could not be
// acted on comes back in `skipped` with a reason, and the rest are done.
const BULK_MAX = 500;

// Validate a bulk id list and load the bottles with their cellars. Access is
// judged per SOURCE cellar (resolved once each) against `minRole`: 'owner'
// for a move (the single move route's rule), 'editor' for edits and consumes
// (the single PUT / consume rule). Same disclosure as the single routes: a
// bottle you may not touch reads as not_found. Items come back in request
// order, deduplicated, each either { id, bottle, cellar } or { id, reason }.
// Returns { error } | { ids, items }.
async function resolveBulkBottles(req, bottleIds, minRole) {
  if (!Array.isArray(bottleIds) || bottleIds.length === 0) {
    return { error: { status: 400, message: 'bottleIds must be a non-empty array' } };
  }
  if (bottleIds.length > BULK_MAX) {
    return { error: { status: 400, message: `At most ${BULK_MAX} bottles per request` } };
  }
  if (!bottleIds.every((x) => typeof x === 'string' && mongoose.isValidObjectId(x))) {
    return { error: { status: 400, message: 'bottleIds must be valid bottle ids' } };
  }
  const ids = [...new Set(bottleIds.map(String))];
  const bottles = await Bottle.find({ _id: { $in: ids.map((x) => new mongoose.Types.ObjectId(x)) } });
  const byId = new Map(bottles.map((b) => [String(b._id), b]));
  const cellarCache = new Map();
  const cellarOf = async (cellarId) => {
    const key = String(cellarId);
    if (!cellarCache.has(key)) cellarCache.set(key, await Cellar.findById(cellarId));
    return cellarCache.get(key);
  };
  const items = [];
  for (const id of ids) {
    const bottle = byId.get(id);
    if (!bottle) { items.push({ id, reason: 'not_found' }); continue; }
    const cellar = await cellarOf(bottle.cellar);
    // Same rules as middleware/bottleAccess: a soft-deleted cellar is frozen
    // (its bottles read as not found until restore or purge), and the role
    // ladder is the middleware's ROLE_LEVELS, not a second copy of it.
    if (!cellar || cellar.deletedAt) { items.push({ id, reason: 'not_found' }); continue; }
    const role = getCellarRole(cellar, req.user.id);
    if ((ROLE_LEVELS[role] || 0) < (ROLE_LEVELS[minRole] || 0)) { items.push({ id, reason: 'not_found' }); continue; }
    items.push({ id, bottle, cellar });
  }
  return { ids, items };
}

// POST /api/bottles/bulk-move - Move MANY active bottles to another cellar you
// own, in ONE request. Same rules and mechanics as the single move above,
// applied per bottle through the shared services/rackOps.moveBottleToCellar:
// the SOURCE cellar must be owned (not merely editable), active bottles only,
// each bottle lands unplaced, dual audit per bottle.
//
// Body:     { bottleIds: string[] (1..BULK_MAX), toCellarId }
// Response: { moved, movedIds: string[], skipped: [{ id, reason }], toCellar: { _id, name } }
//   reason ∈ 'not_found', 'same_cellar', 'not_active', 'conflict'
router.post('/bulk-move', async (req, res) => {
  try {
    const { bottleIds, toCellarId } = req.body || {};
    const resolved = await resolveBulkBottles(req, bottleIds, 'owner');
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (!toCellarId || !mongoose.isValidObjectId(String(toCellarId))) {
      return res.status(400).json({ error: 'Invalid destination cellar' });
    }

    // Destination: an active cellar the user OWNS (same as the single move).
    const destCellar = await Cellar.findOne({
      _id: new mongoose.Types.ObjectId(String(toCellarId)),
      user: req.user.id,
      deletedAt: null,
    });
    if (!destCellar) return res.status(404).json({ error: 'Destination cellar not found' });

    const movedIds = [];
    const skipped = [];
    for (const item of resolved.items) {
      if (item.reason) { skipped.push({ id: item.id, reason: item.reason }); continue; }
      const { id, bottle, cellar: sourceCellar } = item;
      if (String(sourceCellar._id) === String(destCellar._id)) { skipped.push({ id, reason: 'same_cellar' }); continue; }
      if (bottle.status !== 'active' && bottle.status !== ORDERED_STATUS) { skipped.push({ id, reason: 'not_active' }); continue; }
      const result = await moveBottleToCellar(bottle, sourceCellar, destCellar, req);
      if (result.error) { skipped.push({ id, reason: result.error.code || 'error' }); continue; }
      movedIds.push(id);
    }

    // One summary row on top of the per-bottle move.out / move.in rows, so the
    // audit log shows "moved 120 bottles" as one act, not 240 lines to count.
    logAudit(req, 'bottle.bulk_move',
      { type: 'cellar', id: destCellar._id, cellarId: destCellar._id },
      { requested: resolved.ids.length, moved: movedIds.length, skipped: skipped.length });

    res.json({
      moved: movedIds.length,
      movedIds,
      skipped,
      toCellar: { _id: destCellar._id, name: destCellar.name },
    });
  } catch (error) {
    console.error('Bulk move error:', error);
    res.status(500).json({ error: 'Failed to move bottles' });
  }
});

// POST /api/bottles/bulk-delete - Move MANY bottles to the cellar's "Recently
// deleted" in ONE request (an import to redo, a batch added wrong). Nothing is gone for good yet: each bottle keeps its
// snapshot and its own photos for TRASH_DAYS and can be restored, one at a
// time or the whole batch (services/bottleTrash). Its rack slot is freed now.
// Editor+ on each bottle's cellar — the single DELETE rule. Any status,
// unless onlyOnOrder: an order's quantity lowered from a list that may be out
// of date (another member marked bottles as arrived meanwhile) takes off only
// bottles still on order; the rest are skipped as 'not_on_order'.
//
// Body:     { bottleIds: string[] (1..BULK_MAX), onlyOnOrder?: boolean }
// Response: { deleted, deletedIds: string[], skipped: [{ id, reason }], batchId, purgeAt }
//   reason ∈ 'not_found', 'not_on_order', 'error'
router.post('/bulk-delete', async (req, res) => {
  try {
    const resolved = await resolveBulkBottles(req, (req.body || {}).bottleIds, 'editor');
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });

    const batchId = new mongoose.Types.ObjectId();
    const deletedAt = new Date();
    const deletedIds = [];
    const skipped = [];
    let firstCellar = null;
    const onlyOnOrder = (req.body || {}).onlyOnOrder === true;
    for (const item of resolved.items) {
      if (item.reason) { skipped.push({ id: item.id, reason: item.reason }); continue; }
      // Read again right before it goes: one marked as arrived since the
      // batch was loaded stays (the window left is milliseconds).
      if (onlyOnOrder && (item.bottle.status !== ORDERED_STATUS
        || !(await Bottle.exists({ _id: item.bottle._id, status: ORDERED_STATUS })))) {
        skipped.push({ id: item.id, reason: 'not_on_order' });
        continue;
      }
      // One bottle that fails is reported, not a 500 halfway through a batch
      // whose first bottles are already in "Recently deleted".
      let result;
      try {
        result = await trashBottle(item.bottle, req, { batchId, deletedAt });
      } catch (err) {
        console.error(`Bulk delete: bottle ${item.id} failed:`, err.message);
        result = { error: { code: 'error' } };
      }
      if (result.error) { skipped.push({ id: item.id, reason: result.error.code || 'error' }); continue; }
      if (!firstCellar) firstCellar = item.cellar;
      deletedIds.push(item.id);
    }

    // One summary row on top of the per-bottle bottle.delete rows.
    if (firstCellar) {
      logAudit(req, 'bottle.bulk_delete',
        { type: 'cellar', id: firstCellar._id, cellarId: firstCellar._id },
        { requested: resolved.ids.length, deleted: deletedIds.length, skipped: skipped.length, batchId: String(batchId), retentionDays: TRASH_DAYS });
    }

    res.json({
      deleted: deletedIds.length,
      deletedIds,
      skipped,
      batchId,
      purgeAt: new Date(deletedAt.getTime() + TRASH_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: 'Failed to delete the bottles' });
  }
});

// POST /api/bottles/bulk - ONE edit or consume applied to MANY bottles.
//   { action: 'update',  bottleIds, fields }  → services/bottleOps.updateBottleFields
//       per bottle. `fields` is limited to BULK_UPDATE_FIELDS — the purchase
//       details a delivery shares (date, shop, price), the reservation
//       ("spoken for X until 2028"), and the drink window and notes a wine and
//       vintage share (notes for the vintage page's "Edit vintage"), and the
//       barcode every bottle of one product carries
//       (the vintage page's "Add barcode") — everything else stays per bottle.
//   { action: 'consume', bottleIds, reason, note, consumedAt, includeReserved }
//       → services/bottleOps.consumeBottle per bottle, one date for all;
//       already-consumed bottles are skipped as not_active, and a "spoken for"
//       bottle as 'reserved' unless includeReserved is true (the single flow
//       warns and the MCP tool refuses without an acknowledgement — bulk must
//       not be the one path that consumes a reservation silently). The
//       restock-gap check runs ONCE per wine+vintage afterwards, not per bottle.
//   { action: 'arrive', bottleIds, arrivedAt }
//       → services/bottleOps.markArrived per bottle: a delivery of bottles on
//       order, one day for all. A bottle not on order is skipped as
//       'not_on_order'. expectedArrival rides 'update' like the purchase
//       details (it is dropped on a bottle that is not on order).
//   { action: 'restore', bottleIds }
//       → services/bottleOps.restoreBottle per bottle: Undo of a bulk "mark
//       as drunk" (the cellar list's and the pick list's), in ONE request —
//       one restore call per bottle ate the member's write budget and could
//       not undo a batch larger than the write limit. The single restore's
//       rules: a bottle not taken out is skipped as 'not_consumed', one taken
//       out more than two days ago as 'restore_window_expired'. Every refusal
//       is per bottle; restore has no payload to reject.
// Editor+ on each bottle's cellar (the single PUT / consume / restore rule).
// A payload the shared validation rejects (a bad date, a note too long) is
// the SAME error for every bottle, so it fails the whole request with that
// message before anything is touched, rather than reporting N identical skips.
// Response: { done, doneIds: string[], skipped: [{ id, reason }] }
const BULK_UPDATE_FIELDS = ['price', 'currency', 'purchaseDate', 'purchaseLocation', 'purchaseUrl', 'reservedFor', 'reservedUntil', 'drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil', 'notes', 'barcode', 'expectedArrival'];
router.post('/bulk', async (req, res) => {
  try {
    const { action, bottleIds } = req.body || {};
    if (!['update', 'consume', 'arrive', 'restore'].includes(action)) {
      return res.status(400).json({ error: 'action must be "update", "consume", "arrive" or "restore"' });
    }
    let fields = null;
    let consumeArgs = null;
    const arriveArgs = action === 'arrive' ? { arrivedAt: req.body.arrivedAt } : null;
    if (action === 'arrive' || action === 'restore') {
      // Nothing more to collect — markArrived validates the date; restore takes none.
    } else if (action === 'update') {
      const src = req.body.fields;
      if (!src || typeof src !== 'object' || Array.isArray(src)) {
        return res.status(400).json({ error: 'fields must be an object' });
      }
      fields = {};
      for (const k of BULK_UPDATE_FIELDS) if (src[k] !== undefined) fields[k] = src[k];
      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: `fields must include at least one of: ${BULK_UPDATE_FIELDS.join(', ')}` });
      }
      // A demo account cannot add a barcode (each code is a vote in the
      // shared lookup). The shared update refuses it per bottle with a 403,
      // which the loop below would turn into "skipped" behind a 200 — refuse
      // the request itself, as the single-bottle route does.
      if (fields.barcode && req.user.isDemo) {
        return res.status(403).json({ error: 'Demo accounts cannot add barcodes' });
      }
      // A bad month is the same error for every bottle: refuse it up front.
      // The shared update only parses it on bottles on order (it drops the
      // field on any other), so an invalid value would otherwise pass or fail
      // depending on which bottle came first in the list.
      if (fields.expectedArrival !== undefined) {
        const p = parseExpectedArrival(fields.expectedArrival);
        if (!p.ok) return res.status(400).json({ error: p.error });
      }
      // A currency: an alias is sent on as its code ("EURO" → "EUR") and a
      // non-string is refused here; an unsupported code is checked below,
      // once the bottles are known.
      if (fields.currency !== undefined && fields.currency !== null && fields.currency !== '') {
        if (typeof fields.currency !== 'string') return res.status(400).json({ error: 'Invalid currency' });
        fields.currency = normalizeCurrency(fields.currency);
      }
    } else {
      const { reason = 'drank', note, consumedAt } = req.body;
      // consumeBottle's own restock-gap check is skipped: a case of twelve must
      // not fire twelve pipelines (and twelve paid embedding calls when the
      // pair is uncached). One check per wine+vintage runs after the loop.
      consumeArgs = { reason, note, consumedAt, skipRestockCheck: true };
    }
    const includeReserved = req.body.includeReserved === true;

    const resolved = await resolveBulkBottles(req, bottleIds, 'editor');
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });

    // An unsupported currency is refused once, not skipped bottle by bottle —
    // unless it is the own code of a bottle in the selection (an older
    // import's code, which a lot edit of that bottle carries). The shared
    // update then keeps it or refuses it per bottle.
    if (fields && typeof fields.currency === 'string' && fields.currency && !isSupportedCurrency(fields.currency)
        && !resolved.items.some((it) => it.bottle && normalizeCurrency(it.bottle.currency || '') === fields.currency)) {
      return res.status(400).json({ error: parseCurrency(fields.currency).error });
    }

    const doneIds = [];
    const skipped = [];
    const restockPairs = new Map(); // `${wine}|${vintage}` → one representative bottle
    let touched = false;
    let firstCellar = null;
    for (const item of resolved.items) {
      if (item.reason) { skipped.push({ id: item.id, reason: item.reason }); continue; }
      const { id, bottle, cellar } = item;
      if (!firstCellar) firstCellar = cellar;
      let result;
      if (action === 'update') {
        result = await updateBottleFields(bottle, { ...fields }, req);
      } else if (action === 'arrive') {
        if (bottle.status !== ORDERED_STATUS) { skipped.push({ id, reason: 'not_on_order' }); continue; }
        result = await markArrived(bottle, arriveArgs, req);
      } else if (action === 'restore') {
        if (!CONSUMED_STATUSES.includes(bottle.status)) { skipped.push({ id, reason: 'not_consumed' }); continue; }
        result = await restoreBottle(bottle, req);
      } else {
        if (bottle.status !== 'active') { skipped.push({ id, reason: 'not_active' }); continue; }
        if (!includeReserved && isReserved(bottle)) { skipped.push({ id, reason: 'reserved' }); continue; }
        result = await consumeBottle(bottle, consumeArgs, req);
        if (!result.error) restockPairs.set(`${bottle.wineDefinition || ''}|${bottle.vintage || 'NV'}`, bottle);
      }
      if (result.error) {
        // A 400 about THIS bottle's own values (its peak outside the new
        // window) is a per-bottle skip, whatever its position in the list;
        // only a payload-wide error still fails the whole request up front,
        // so the outcome never depends on the order of the list. A restore
        // refusal is always about the bottle (its two days are over).
        const perBottle = action === 'restore'
          || (result.error.status === 400 && /cannot be (after|before)/.test(result.error.message || ''));
        if (result.error.status === 400 && !touched && !perBottle) {
          return res.status(400).json({ error: result.error.message });
        }
        skipped.push({ id, reason: result.error.code || (result.error.status === 400 ? 'invalid' : 'error') });
        continue;
      }
      touched = true;
      doneIds.push(id);
    }

    // One restock-gap check per distinct wine+vintage among the bottles just
    // drunk. Skipped for demo accounts, as in consumeBottle: an uncached pair
    // fires a paid embedding call.
    if (action === 'consume' && consumeArgs.reason === 'drank' && !req.user.isDemo && restockPairs.size) {
      const { checkRestockGap } = require('../services/restockChecker');
      // Same no-AI rule for a token as consumeBottle (this route is not on
      // the token allowlist today; the option keeps it safe if it ever is).
      for (const b of restockPairs.values()) {
        checkRestockGap(req.user.id, b._id, b.cellar, { storedVectorOnly: !!req.apiToken }).catch(() => {});
      }
    }

    // One summary row on top of the per-bottle update / consume / arrive /
    // restore rows.
    if (firstCellar) {
      const summaryAction = {
        update: 'bottle.bulk_update', consume: 'bottle.bulk_consume', arrive: 'bottle.bulk_arrive', restore: 'bottle.bulk_restore',
      }[action];
      logAudit(req, summaryAction,
        { type: 'cellar', id: firstCellar._id, cellarId: firstCellar._id },
        {
          requested: resolved.ids.length, done: doneIds.length, skipped: skipped.length,
          ...(action === 'update' ? { fields: Object.keys(fields) } : {}),
          ...(action === 'consume' ? { reason: consumeArgs.reason } : {}),
        });
    }

    res.json({ done: doneIds.length, doneIds, skipped });
  } catch (error) {
    console.error('Bulk action error:', error);
    res.status(500).json({ error: 'Failed to apply the change to the bottles' });
  }
});

module.exports = router;
