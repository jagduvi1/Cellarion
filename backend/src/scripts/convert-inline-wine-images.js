/**
 * One-time conversion of wine pictures stored inline (scaling audit
 * 2026-09-25).
 *
 * Until 2026-09-06, approving a wine request copied the photo attached to it
 * into the new wine's record as a data: URI: up to half a megabyte of text
 * that rode along in every list, page and copy that showed the wine, and
 * could not be cached on its own. Pictures are files now: an approval stores
 * the requester's photo as the wine's official picture
 * (routes/admin/wineRequests.js), and wine records refuse inline images.
 *
 * This moves the ones stored before that into files the same way, through
 * attachOfficialWineImage: a BottleImage row (approved, public, the wine's
 * official picture, the credit kept), the file stored as a kept WebP photo, and
 * wine.image pointing at it. A background-removed photo (PNG, what the request
 * form sent) is kept as it is; anything else goes through background removal,
 * like any admin upload. updatedAt moves, so an install holding the wine over
 * the Bridge picks up the picture: an inline one was never sent to it.
 *
 * The photo was approved when its request was, so it is recorded as uploaded
 * and reviewed by the admin who approved it: the wine's createdBy, which an
 * approval sets to the approving admin.
 *
 * Re-runnable: a converted wine no longer matches.
 *
 * Usage (inside the backend container):
 *   node src/scripts/convert-inline-wine-images.js           # dry-run (default): lists them, no changes
 *   node src/scripts/convert-inline-wine-images.js --apply   # convert
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
// Re-indexing a wine populates its country, region and grapes: those models
// must be registered in this process too.
require('../models/Country');
require('../models/Region');
require('../models/Grape');
const { attachOfficialWineImage, decodeInlineImage } = require('../services/imageOps');
const { detectImageFormat } = require('../services/imageSanitizer');
const { logAudit } = require('../services/audit');

const INLINE = { image: { $regex: '^data:' } };

async function convertInlineWineImages({ apply = false, log = console.log, reindex = async () => {} } = {}) {
  const wines = await WineDefinition.find(INLINE).select('_id name producer image imageCredit createdBy').lean();
  const summary = { found: wines.length, converted: 0, skipped: 0, failed: 0 };
  log(`${wines.length} wine(s) with an inline picture${apply ? '' : ' (dry-run: nothing changes; pass --apply to convert)'}`);

  for (const wine of wines) {
    const buffer = decodeInlineImage(wine.image);
    const format = buffer ? detectImageFormat(buffer) : null;
    const bottles = await Bottle.countDocuments({ wineDefinition: wine._id });
    const label = `${wine._id} "${wine.name}" (${wine.producer || 'no producer'}): ${Math.round(wine.image.length / 1024)} kB inline, ${format || 'unreadable'}, ${bottles} bottle(s)`;
    if (!buffer || !format) {
      summary.skipped++;
      log(`  SKIP ${label}: not a readable inline image, left as it is`);
      continue;
    }
    if (!wine.createdBy) {
      summary.skipped++;
      log(`  SKIP ${label}: no approving admin on record, left as it is`);
      continue;
    }
    if (!apply) {
      log(`  would convert ${label}`);
      continue;
    }

    let result;
    try {
      result = await attachOfficialWineImage({
        buffer,
        wineDefinitionId: wine._id,
        credit: wine.imageCredit || null,
        userId: wine.createdBy,
        userRoles: ['admin'],
        keepBackground: format === 'png',
      }, null);
    } catch (err) {
      result = { error: { message: err.message } };
    }
    if (result.error) {
      summary.failed++;
      log(`  FAILED ${label}: ${result.error.message} (left as it is)`);
      continue;
    }

    await WineDefinition.updateOne({ _id: wine._id }, { $set: { updatedAt: new Date() } });
    const url = result.image.processedUrl || result.image.originalUrl;
    logAudit(null, 'admin.wine.image.convert_inline',
      { type: 'wine', id: wine._id },
      { imageId: String(result.image._id), inlineBytes: wine.image.length, url });
    // Awaited here: the re-index attachOfficialWineImage starts is fire-and-forget.
    await reindex(wine._id);
    summary.converted++;
    log(`  converted ${label} → ${url}`);
  }

  log(`found ${summary.found}, converted ${summary.converted}, skipped ${summary.skipped}, failed ${summary.failed}`);
  return summary;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  // Without initialize() the re-index in attachOfficialWineImage is a silent
  // no-op, and wine search keeps the inline picture until the next reindex.
  const searchService = require('../services/search');
  if (apply) {
    await searchService.initialize();
    if (searchService.getIsAvailable?.() === false) {
      console.warn('Meilisearch unavailable: wine search keeps the old picture until the next reindex.');
    }
  }
  const summary = await convertInlineWineImages({ apply, reindex: (id) => searchService.indexWine(id) });
  // Background removal (for a non-PNG picture) runs in this process: let it
  // finish before disconnecting.
  if (apply) await require('../services/imageProcessor').whenProcessingIdle();
  // logAudit persists fire-and-forget: give the last writes a moment before the
  // connection goes (same as scripts/send-supporter-thank-you.js).
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await mongoose.disconnect();
  return summary;
}

if (require.main === module) {
  main()
    .then((s) => process.exit(s.failed ? 1 : 0))
    .catch((err) => { console.error('FAILED:', err); process.exit(1); });
}

module.exports = { convertInlineWineImages };
