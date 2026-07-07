/**
 * One-time cleanup of duplicate wine images.
 *
 * Imports and re-uploads historically created several BottleImage records for
 * the SAME photo (identical contentHash) on the same wine — cluttering the
 * admin by-wine curation view and the wine's gallery. New imports no longer do
 * this (import-time dedup), and admins can delete stragglers by hand; this
 * script clears the existing backlog in one pass.
 *
 * For every (wine, contentHash, uploader) group with more than one
 * non-rejected, file-backed record, it keeps ONE copy and deletes the rest,
 * using the same handover rules as DELETE /api/admin/images/:id:
 *   - keeper preference: official (assignedToWine) → matches WineDefinition.image
 *     → approved+public → approved → oldest
 *   - bottles whose starred defaultImage was a deleted record are repointed to
 *     the keeper (byte-identical photo — nothing visibly changes for the user)
 *   - if WineDefinition.image pointed at a deleted record's file, it is updated
 *     to the keeper's file
 *   - file removal is reference-safe (a file shared with a surviving record is
 *     kept); records are hard-deleted, no notifications
 *
 * Only same-uploader duplicates are touched: distinct users who happened to
 * upload the same photo keep their own records (none exist today, but the
 * script must stay safe if they ever do).
 *
 * Usage (inside the backend container):
 *   node src/scripts/cleanup-duplicate-images.js           # dry-run (default)
 *   node src/scripts/cleanup-duplicate-images.js --apply   # actually delete
 */
const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const { unlinkImageFiles } = require('../services/imageProcessor');

const APPLY = process.argv.includes('--apply');

function keeperScore(img, wine) {
  let s = 0;
  if (img.assignedToWine) s += 100;
  const url = img.processedUrl || img.originalUrl;
  if (wine && wine.image && url === wine.image) s += 50;
  if (img.status === 'approved' && img.visibility === 'public') s += 20;
  else if (img.status === 'approved') s += 10;
  return s;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${APPLY ? 'APPLY (deleting)' : 'DRY-RUN (no changes; pass --apply to execute)'}\n`);

  // Duplicate groups: same effective wine + same photo bytes + same uploader.
  const groups = await BottleImage.aggregate([
    { $match: {
      status: { $ne: 'rejected' },
      contentHash: { $ne: null },
      $or: [{ processedUrl: { $ne: null } }, { originalUrl: { $ne: null } }],
    } },
    { $lookup: { from: 'bottles', localField: 'bottle', foreignField: '_id', as: '_b' } },
    { $addFields: { effWine: { $ifNull: ['$wineDefinition', { $arrayElemAt: ['$_b.wineDefinition', 0] }] } } },
    { $match: { effWine: { $ne: null } } },
    { $group: {
      _id: { wine: '$effWine', hash: '$contentHash', uploader: '$uploadedBy' },
      ids: { $push: '$_id' },
      n: { $sum: 1 },
    } },
    { $match: { n: { $gt: 1 } } },
  ]).allowDiskUse(true);

  const totals = { groups: 0, deleted: 0, repointedBottles: 0, winesUpdated: 0 };

  for (const g of groups) {
    const wine = await WineDefinition.findById(g._id.wine).select('name producer image imageCredit');
    if (!wine) continue; // wine deleted out from under its images — leave for manual review
    const imgs = await BottleImage.find({ _id: { $in: g.ids } });
    if (imgs.length < 2) continue;

    const sorted = imgs.slice().sort((a, b) =>
      keeperScore(b, wine) - keeperScore(a, wine) || new Date(a.createdAt) - new Date(b.createdAt));
    const keeper = sorted[0];
    const losers = sorted.slice(1);
    const keeperUrl = keeper.processedUrl || keeper.originalUrl;

    totals.groups++;
    console.log(`${wine.name} (${wine.producer}) — photo ${g._id.hash.slice(0, 10)}…: keep ${keeper._id}, delete ${losers.length}`);
    if (!APPLY) { totals.deleted += losers.length; continue; }

    for (const loser of losers) {
      // Starred handover: bottles pointing at the deleted record get the keeper.
      const rp = await Bottle.updateMany(
        { defaultImage: loser._id },
        { $set: { defaultImage: keeper._id } }
      );
      totals.repointedBottles += rp.modifiedCount || 0;

      // Official handover: if the wine's image is this record's file, move it
      // to the keeper (keeper preference makes this rare, but a stale URL or a
      // drifted assignedToWine flag can still hit it).
      const loserUrl = loser.processedUrl || loser.originalUrl;
      if (wine.image && wine.image === loserUrl && keeperUrl) {
        wine.image = keeperUrl;
        wine.imageCredit = keeper.credit || null;
        await wine.save();
        if (!keeper.assignedToWine) {
          keeper.assignedToWine = true;
          keeper.wineDefinition = wine._id;
          keeper.status = 'approved';
          keeper.visibility = 'public';
          await keeper.save();
        }
        totals.winesUpdated++;
        // Search reindex intentionally skipped (script runs without Meili
        // init); the wine doc URL change is picked up on the next full sync.
      }

      await unlinkImageFiles(loser); // reference-safe: shared files survive
      await loser.deleteOne();
      totals.deleted++;
    }
  }

  console.log(`\n${APPLY ? 'Done' : 'Would do'}: ${totals.groups} duplicate groups, ` +
    `${totals.deleted} records deleted, ${totals.repointedBottles} bottle stars repointed, ` +
    `${totals.winesUpdated} wine images updated.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
