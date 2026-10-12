/**
 * "Recently deleted" — the trash a bulk delete moves bottles to.
 *
 * Forum feedback 2026-10-12: an import came in without its prices, and the
 * only way to redo it was to delete the bottles one at a time. A bulk delete
 * fixes that, but deleting a hundred bottles for good with one tap is too easy
 * to regret, so a bulk delete keeps every bottle for TRASH_DAYS first:
 *
 *  - trashBottle stores the snapshot the MCP delete_bottle undo already uses
 *    (bottleOps.snapshotBottleForDelete), THEN runs the shared delete cascade
 *    — rack slot freed, registry photos detached, an import request only this
 *    bottle waited on withdrawn — but keeps the bottle's own photos, which
 *    still point at its id.
 *  - restoreTrashed puts the bottle back under the same _id
 *    (bottleOps.restoreDeletedBottle), so its photos, tasting notes, personal
 *    data and list entries reconnect, and it re-takes its rack slot if free.
 *  - purgeTrashRows deletes rows for good: the bottle's own photos (files
 *    first) and the row. The daily job runs it on rows past purgeAt; the
 *    cellar purge and account erasure run it on theirs.
 *
 * Same 30 days as a deleted cellar (services/cellarRetentionJob).
 */
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const DeletedBottle = require('../models/DeletedBottle');
const WineDefinition = require('../models/WineDefinition');
const WineRequest = require('../models/WineRequest');
const { snapshotBottleForDelete, removeBottleCascade, restoreDeletedBottle } = require('./bottleOps');
const { logAudit } = require('./audit');

const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// What the "Recently deleted" list shows for a bottle, read once now: the
// registry wine, or the import request a bottle still waiting on one carries.
async function labelFor(bottle) {
  let name = '';
  let producer = '';
  if (bottle.wineDefinition) {
    const wine = await WineDefinition.findById(bottle.wineDefinition).select('name producer').lean();
    if (wine) { name = wine.name || ''; producer = wine.producer || ''; }
  } else if (bottle.pendingWineRequest) {
    const request = await WineRequest.findById(bottle.pendingWineRequest).select('wineName producer').lean();
    if (request) { name = request.wineName || ''; producer = request.producer || ''; }
  }
  return {
    name,
    producer,
    vintage: bottle.vintage || '',
    bottleSize: bottle.bottleSize || '',
    status: bottle.status || '',
  };
}

/**
 * Move one bottle to "Recently deleted". The row is written BEFORE anything
 * is deleted — a bottle must never be gone without its way back — and taken
 * out again if the delete cascade refuses.
 * Returns { error } | { row }.
 */
async function trashBottle(bottle, req, { batchId, deletedAt = new Date() }) {
  const { snapshot } = await snapshotBottleForDelete(bottle);
  const row = await DeletedBottle.create({
    user: bottle.user,
    cellar: bottle.cellar,
    deletedBy: req.user.id,
    bottleId: bottle._id,
    wineDefinition: bottle.wineDefinition || null,
    batchId,
    label: await labelFor(bottle),
    snapshot,
    deletedAt,
    purgeAt: new Date(deletedAt.getTime() + TRASH_DAYS * DAY_MS),
  });
  const result = await removeBottleCascade(bottle, req, 'bottle.delete', {
    anyStatus: true,
    keepOwnPhotos: true,
    auditDetail: { trashed: true, batchId: String(batchId) },
  });
  if (result.error) {
    await DeletedBottle.deleteOne({ _id: row._id });
    return { error: result.error };
  }
  return { row };
}

/**
 * Bring one bottle back from "Recently deleted". A wine merge since the
 * delete re-pointed the row's wineDefinition, which wins over the snapshot's.
 * A bottle that exists again (its delete never finished) only loses its row.
 * Returns { error: { status, code, message } } | { bottle, placed, position }.
 */
async function restoreTrashed(row, req) {
  const snapshot = { ...row.snapshot, bottle: { ...row.snapshot.bottle } };
  if (row.wineDefinition) snapshot.bottle.wineDefinition = row.wineDefinition;
  const result = await restoreDeletedBottle(snapshot, req, { via: 'trash' });
  if (!result.error || result.error.code === 'exists') {
    await DeletedBottle.deleteOne({ _id: row._id });
  }
  return result;
}

/**
 * Delete trash rows for good: each bottle's own photos (files before their
 * documents, which are the only reference to them), then the rows. A bottle
 * that exists again keeps its photos — only its stale row goes.
 * Returns the number of rows removed.
 */
async function purgeTrashRows(filter) {
  const rows = await DeletedBottle.find(filter).select('_id bottleId').lean();
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.bottleId);
  const live = new Set((await Bottle.find({ _id: { $in: ids } }).distinct('_id')).map(String));
  const gone = ids.filter((id) => !live.has(String(id)));
  if (gone.length > 0) {
    const { OWN_PHOTO } = require('./photoRetention');
    const { unlinkImageFiles } = require('./imageProcessor');
    const photos = await BottleImage.find({ bottle: { $in: gone }, ...OWN_PHOTO }).select('originalUrl processedUrl').lean();
    for (const photo of photos) await unlinkImageFiles(photo);
    await BottleImage.deleteMany({ bottle: { $in: gone }, ...OWN_PHOTO });
  }
  await DeletedBottle.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
  return rows.length;
}

// Daily: rows past purgeAt are deleted for good, one audit row per owner.
async function runTrashRetentionPurge(now = new Date()) {
  const owners = await DeletedBottle.distinct('user', { purgeAt: { $lte: now } });
  let purged = 0;
  for (const owner of owners) {
    try {
      const n = await purgeTrashRows({ user: owner, purgeAt: { $lte: now } });
      purged += n;
      if (n > 0) logAudit(null, 'bottle.trash_purge', { type: 'user', id: owner }, { bottles: n, retentionDays: TRASH_DAYS });
    } catch (err) {
      console.error(`[bottleTrash] purge failed for user ${owner}:`, err);
    }
  }
  if (purged > 0) console.log(`[bottleTrash] purged ${purged} bottle(s) past ${TRASH_DAYS} days in Recently deleted`);
  return { purged };
}

module.exports = { TRASH_DAYS, trashBottle, restoreTrashed, purgeTrashRows, runTrashRetentionPurge };
