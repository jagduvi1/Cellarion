/**
 * Permanent cellar deletion — the single cascade used by BOTH the admin
 * permanent-delete route and the 30-day retention job, so the two paths can
 * never diverge.
 *
 * Cascade order matters:
 *  - bottle ids are collected BEFORE deleteMany so their Meilisearch documents
 *    (which carry the owner's free-text notes/location) can be removed — there
 *    is no scheduled resync, so skipping this leaves ghost bottles in search
 *    indefinitely (full-sync only runs against an empty index).
 *  - image files are unlinked BEFORE their BottleImage docs are deleted (the
 *    docs hold the only reference to the files on disk). Shared registry
 *    images (assignedToWine) are kept — only their dead bottle ref is
 *    detached — matching the userDataRegistry pattern.
 *  - wine lists are deleted HERE, not on soft-delete: the soft delete is
 *    reversible, so curated lists (and their uploaded logo files) must
 *    survive until the retention window closes.
 */
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Rack = require('../models/Rack');
const CellarLayout = require('../models/CellarLayout');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const ImportSession = require('../models/ImportSession');
const PendingShare = require('../models/PendingShare');
const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const { deleteLogoFilesFor } = require('./wineListLogos');
const { unlinkImageFiles } = require('./imageProcessor');
const searchService = require('./search');

/**
 * Hard-delete a cellar and everything that only exists because of it.
 * The caller is responsible for authorization and for verifying the cellar
 * is soft-deleted; this function just executes the cascade.
 *
 * @param {import('mongoose').Types.ObjectId|string} cellarId
 * @returns {{ racksDeleted: number, bottlesDeleted: number, imagesDeleted: number }}
 */
async function purgeCellarPermanently(cellarId) {
  const bottleIds = await Bottle.find({ cellar: cellarId }).distinct('_id');

  let imagesDeleted = 0;
  if (bottleIds.length > 0) {
    const own = await BottleImage.find({ bottle: { $in: bottleIds }, assignedToWine: { $ne: true } })
      .select('originalUrl processedUrl').lean();
    for (const img of own) await unlinkImageFiles(img);
    const [delResult] = await Promise.all([
      BottleImage.deleteMany({ bottle: { $in: bottleIds }, assignedToWine: { $ne: true } }),
      BottleImage.updateMany({ bottle: { $in: bottleIds }, assignedToWine: true }, { $unset: { bottle: '' } }),
    ]);
    imagesDeleted = delResult.deletedCount;
  }

  await deleteLogoFilesFor(WineList, { cellar: cellarId });

  const [rackResult, bottleResult] = await Promise.all([
    Rack.deleteMany({ cellar: cellarId }),
    Bottle.deleteMany({ cellar: cellarId }),
    CellarLayout.deleteMany({ cellar: cellarId }),
    CellarValueSnapshot.deleteMany({ cellar: cellarId }),
    ImportSession.deleteMany({ cellar: cellarId }),
    PendingShare.deleteMany({ cellar: cellarId }),
    WineList.deleteMany({ cellar: cellarId }),
  ]);

  await searchService.removeBottles(bottleIds);

  await Cellar.deleteOne({ _id: cellarId });

  return {
    racksDeleted: rackResult.deletedCount,
    bottlesDeleted: bottleResult.deletedCount,
    imagesDeleted,
  };
}

module.exports = { purgeCellarPermanently };
