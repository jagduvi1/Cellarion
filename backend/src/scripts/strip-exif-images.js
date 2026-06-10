/**
 * One-off backfill: strip EXIF/GPS metadata from already-uploaded images.
 *
 * Re-encodes every image in /app/uploads/originals and
 * /app/uploads/wine-list-logos in place (filenames and URLs are unchanged).
 * Processed PNGs in /app/uploads/processed are skipped — rembg re-encodes
 * them via PIL, which already drops all metadata.
 *
 * Idempotent — re-running re-encodes already-clean files to the same clean
 * result. No database access needed. Run inside the backend container:
 *   docker exec cellarion-backend node src/scripts/strip-exif-images.js
 */

const fs = require('fs');
const path = require('path');
const { stripImageMetadata } = require('../services/imageSanitizer');

const DIRS = [
  '/app/uploads/originals',
  '/app/uploads/wine-list-logos',
];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

(async () => {
  let stripped = 0;
  let failed = 0;
  let skipped = 0;

  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) {
      console.log(`[strip-exif-images] ${dir} does not exist, skipping`);
      continue;
    }

    const files = fs.readdirSync(dir);
    console.log(`[strip-exif-images] ${dir}: ${files.length} files`);

    for (const file of files) {
      const filePath = path.join(dir, file);
      if (!fs.statSync(filePath).isFile() || !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        skipped++;
        continue;
      }
      try {
        await stripImageMetadata(filePath);
        stripped++;
      } catch (err) {
        // Leave the file in place — it may be corrupt, but deleting is an
        // operator decision, not the migration's.
        console.error(`[strip-exif-images] FAILED ${filePath}: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`[strip-exif-images] done: ${stripped} stripped, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
})();
