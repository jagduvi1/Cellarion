/**
 * One-time backfill (2026-09-27): link every published bottle photo to its wine.
 *
 * A photo uploaded on a bottle carries no wine of its own — the bottle does.
 * Publishing it (approved + public) is meant to make it a photo OF THE WINE:
 * every owner of that wine sees it in their gallery and can pick it as their
 * bottle's picture, and it can become the wine's registry image. Until
 * 2026-09-27 "approve public" left the wine reference empty, so a published
 * bottle photo was visible on that one bottle only and never reached the wine.
 * routes/admin/images.js now links the wine at approval; this links the photos
 * approved before.
 *
 *   node src/scripts/backfill-published-photo-wines.js                    # dry run: counts only
 *   node src/scripts/backfill-published-photo-wines.js --apply            # link the photos
 *   node src/scripts/backfill-published-photo-wines.js --apply --assign-missing
 *       # …and give every wine that has no picture its OLDEST published
 *       # photo as the registry image — what approving does when the wine
 *       # has none. Re-indexes those wines for search.
 *
 * Re-runnable: a linked photo is no longer a candidate, and a wine with a
 * picture is never touched.
 */
const mongoose = require('mongoose');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
// Re-indexing a wine populates its country, region and grapes: those models
// must be registered in this process too.
require('../models/Country');
require('../models/Region');
require('../models/Grape');

const PUBLISHED = { kind: { $ne: 'label-scan' }, status: 'approved', visibility: 'public' };

/**
 * Published bottle photos that carry no wine, linked to their bottle's wine.
 * @returns {Promise<{candidates: number, linked: number, bottleGone: number, bottleWithoutWine: number}>}
 */
async function linkPublishedPhotos({ apply = false } = {}) {
  const photos = await BottleImage.find({ ...PUBLISHED, wineDefinition: null, bottle: { $ne: null } }, 'bottle').lean();
  const bottleIds = [...new Set(photos.map((p) => String(p.bottle)))];
  const bottles = bottleIds.length ? await Bottle.find({ _id: { $in: bottleIds } }, 'wineDefinition').lean() : [];
  const wineOf = new Map(bottles.map((b) => [String(b._id), b.wineDefinition ? String(b.wineDefinition) : null]));
  const result = { candidates: photos.length, linked: 0, bottleGone: 0, bottleWithoutWine: 0 };
  for (const p of photos) {
    if (!wineOf.has(String(p.bottle))) { result.bottleGone++; continue; }
    const wineId = wineOf.get(String(p.bottle));
    if (!wineId) { result.bottleWithoutWine++; continue; }
    // `wineDefinition: null` in the filter: never overwrite a wine set since the read.
    if (apply) await BottleImage.updateOne({ _id: p._id, wineDefinition: null }, { $set: { wineDefinition: wineId } });
    result.linked++;
  }
  return result;
}

/**
 * Every wine that has published photos but no picture gets its OLDEST
 * published photo as the registry image (the same choice approval makes when
 * the wine has none). `indexWine`, when given, is called per assigned wine.
 * @returns {Promise<{winesWithPublishedPhotos: number, winesWithoutImage: number, assigned: number}>}
 */
async function assignMissingImages({ apply = false, indexWine = null } = {}) {
  const photos = await BottleImage.find(
    { ...PUBLISHED, wineDefinition: { $ne: null } },
    'wineDefinition processedUrl originalUrl credit createdAt'
  ).lean();
  const byWine = new Map();
  for (const p of photos) {
    const k = String(p.wineDefinition);
    if (!byWine.has(k)) byWine.set(k, []);
    byWine.get(k).push(p);
  }
  const wineIds = [...byWine.keys()];
  const bare = wineIds.length
    ? await WineDefinition.find(
        { _id: { $in: wineIds }, $or: [{ image: null }, { image: { $exists: false } }, { image: '' }] },
        '_id'
      ).lean()
    : [];
  const result = { winesWithPublishedPhotos: wineIds.length, winesWithoutImage: bare.length, assigned: 0 };
  for (const w of bare) {
    const list = (byWine.get(String(w._id)) || [])
      .filter((p) => p.processedUrl || p.originalUrl)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (!list.length) continue;
    const pick = list[0];
    if (apply) {
      await BottleImage.updateMany({ wineDefinition: w._id, assignedToWine: true }, { $set: { assignedToWine: false } });
      await BottleImage.updateOne({ _id: pick._id }, { $set: { assignedToWine: true } });
      await WineDefinition.updateOne(
        { _id: w._id },
        { $set: { image: pick.processedUrl || pick.originalUrl, imageCredit: pick.credit || null } }
      );
      if (indexWine) await indexWine(w._id);
    }
    result.assigned++;
  }
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const assignMissing = process.argv.includes('--assign-missing');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN (no changes; pass --apply to execute)'}`);

  const linked = await linkPublishedPhotos({ apply });
  console.log(`Published bottle photos without a wine: ${linked.candidates}`);
  console.log(`  ${apply ? 'linked' : 'would link'}: ${linked.linked}; bottle gone: ${linked.bottleGone}; bottle has no wine yet: ${linked.bottleWithoutWine}`);

  if (assignMissing) {
    let indexWine = null;
    if (apply) {
      // Without initialize() every indexWine is a silent no-op.
      const searchService = require('../services/search');
      await searchService.initialize();
      if (searchService.getIsAvailable?.() === false) {
        console.warn('Meilisearch unavailable — wine search keeps the old picture until the next reindex.');
      } else {
        indexWine = (id) => searchService.indexWine(id);
      }
    }
    const a = await assignMissingImages({ apply, indexWine });
    console.log(`Wines with published photos: ${a.winesWithPublishedPhotos}; of those without a picture: ${a.winesWithoutImage}`);
    console.log(`  ${apply ? 'assigned' : 'would assign'} the oldest published photo: ${a.assigned}`);
  }

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { linkPublishedPhotos, assignMissingImages };
