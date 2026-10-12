const mongoose = require('mongoose');

/**
 * DeletedBottle — one bottle in a cellar's "Recently deleted", the trash a
 * bulk delete moves bottles to (forum feedback 2026-10-12: a whole import had
 * to be deleted so it could be done again, and deleting a hundred bottles for
 * good with one tap is too easy to regret).
 *
 * The bottle document itself is gone from `bottles`, so nothing else in the
 * app (stats, search, racks, exports, the MCP) has to learn to skip it. This
 * row keeps what a restore needs — services/bottleOps.snapshotBottleForDelete,
 * the same snapshot the MCP delete_bottle undo uses — and the restore puts the
 * bottle back under its ORIGINAL _id, so tasting notes, personal data, list
 * entries and its photos reconnect by themselves.
 *
 * The bottle's own photos are NOT deleted when it is trashed: they keep
 * pointing at the (absent) bottle id and come back with it. They are deleted,
 * files first, when the row is purged (services/bottleTrash.purgeTrashRows).
 *
 * Retention: `purgeAt` = deletedAt + TRASH_DAYS (services/bottleTrash). A
 * daily job purges expired rows; there is deliberately NO TTL index, because a
 * TTL delete would drop the row without the photo cleanup and orphan the files.
 *
 * GDPR: registered in services/userDataRegistry.js — exported with the
 * account, purged (with its photos) on account deletion; a deletion by
 * another member of a shared cellar is re-pointed to the [deleted] sentinel.
 */
const deletedBottleSchema = new mongoose.Schema({
  // The bottle's owner (Bottle.user) and cellar, as they were at deletion.
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  cellar: { type: mongoose.Schema.Types.ObjectId, ref: 'Cellar', required: true },
  // Who pressed delete — the owner, or an editor of a shared cellar.
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The deleted bottle's _id, which the restore re-uses.
  bottleId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  // Kept outside the snapshot so a wine merge can re-point it
  // (routes/admin/wines.reassignWineRefs) and the registry's "is this wine
  // still referenced?" guards can count it. Wins over the snapshot's copy.
  wineDefinition: { type: mongoose.Schema.Types.ObjectId, ref: 'WineDefinition', default: null, index: true },
  // One id per bulk delete, so "Undo" and "Restore all" act on the batch.
  batchId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  // What the list shows, read once at deletion (the wine may change later).
  label: {
    name: { type: String, default: '' },
    producer: { type: String, default: '' },
    vintage: { type: String, default: '' },
    bottleSize: { type: String, default: '' },
    status: { type: String, default: '' },
  },
  // { bottle, rack, registryPhotoIds, wineRequest } — see snapshotBottleForDelete.
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  deletedAt: { type: Date, default: Date.now },
  purgeAt: { type: Date, required: true, index: true },
}, { minimize: false });

deletedBottleSchema.index({ cellar: 1, deletedAt: -1 });

module.exports = mongoose.model('DeletedBottle', deletedBottleSchema);
