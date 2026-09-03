/**
 * One-time cleanup of RETAINED original uploads.
 *
 * Support ticket 2026-09-03: a user found their raw bottle photos — background,
 * kitchen, hands — still served from /api/uploads/originals/. Since that fix,
 * services/imageProcessor deletes the raw upload as soon as background removal
 * has produced the processed file (discardOriginal). Every image processed
 * BEFORE it still has both files on disk — unless an admin approved it, which
 * was the only path that used to delete the original. This script brings that
 * backlog in line with the new rule.
 *
 * For every non-label-scan BottleImage whose originalUrl and processedUrl are
 * both set and DIFFERENT — a keepBackground row has them equal (its original
 * IS the kept file) and is untouched — and whose processed file is actually on
 * disk (never delete the only copy), the original file is unlinked
 * (reference-safe: a file another record still points at is kept) and
 * originalUrl is nulled.
 *
 * Out of scope, on purpose:
 *   - kind:'label-scan' rows — curation evidence with its own bounded retention
 *     (services/scanImageRetentionJob)
 *   - rows with no processed file (a failed rembg run awaiting retry, an
 *     imported never-cropped photo) — the original is all they have
 *
 * Usage (inside the backend container):
 *   node src/scripts/purge-retained-originals.js           # dry-run (default)
 *   node src/scripts/purge-retained-originals.js --apply   # actually delete
 */
const fs = require('fs');
const mongoose = require('mongoose');
const BottleImage = require('../models/BottleImage');
const { safeUploadPath, discardOriginal } = require('../services/imageProcessor');

const APPLY = process.argv.includes('--apply');

function fileSize(url) {
  try {
    return fs.statSync(safeUploadPath(url.replace('/api/uploads/', ''))).size;
  } catch {
    return null;
  }
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${APPLY ? 'APPLY (deleting originals)' : 'DRY-RUN (no changes; pass --apply to execute)'}\n`);

  const cursor = BottleImage.find({
    kind: { $ne: 'label-scan' },
    originalUrl: { $ne: null },
    processedUrl: { $ne: null },
    $expr: { $ne: ['$originalUrl', '$processedUrl'] },
  }).select('_id originalUrl processedUrl keepBackground status').cursor();

  let candidates = 0;
  let discarded = 0;
  let bytes = 0;
  let noProcessedFile = 0;
  let alreadyGone = 0;

  for await (const image of cursor) {
    candidates++;
    if (fileSize(image.processedUrl) === null) {
      // The processed file is missing, so the original is the only copy left.
      // Leave it — that is a repair case, not a cleanup case.
      noProcessedFile++;
      console.log(`  keep   ${image._id} — processed file missing on disk (${image.processedUrl})`);
      continue;
    }
    const size = fileSize(image.originalUrl);
    if (size === null) alreadyGone++; else bytes += size;
    if (APPLY) {
      await discardOriginal(image);
      discarded++;
    }
  }

  console.log(`\nCandidates (original + distinct processed): ${candidates}`);
  console.log(`  kept, processed file missing on disk:     ${noProcessedFile}`);
  console.log(`  original file already absent (row only):  ${alreadyGone}`);
  console.log(`  original bytes on disk:                   ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(APPLY ? `  discarded:                                ${discarded}` : '  (dry-run — nothing changed)');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
