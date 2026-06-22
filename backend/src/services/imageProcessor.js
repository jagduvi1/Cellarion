const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROCESSED_DIR } = require('../config/upload');
const BottleImage = require('../models/BottleImage');

/**
 * SHA-256 (hex) of an image's bytes — the dedup key stored on BottleImage.contentHash.
 * Hash the file we KEEP and EXPORT (the cropped/processed image when it exists,
 * else the original), so a cellar export re-imported by the same user matches an
 * image they already have and is reused instead of being written again. Used by
 * the live upload path, the processor, and the backfill migration so all images
 * carry a hash on the same basis as services/cellarImport.js.
 */
function hashImageBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';
const UPLOADS_ROOT = '/app/uploads';

function safeUploadPath(relativePart) {
  const resolved = path.resolve(UPLOADS_ROOT, relativePart);
  if (!resolved.startsWith(UPLOADS_ROOT + path.sep) && resolved !== UPLOADS_ROOT) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

/**
 * Best-effort unlink of a BottleImage's on-disk files (original + processed).
 * Used by GDPR erasure so the underlying files don't outlive the DB rows that
 * are their only reference. Never throws — a missing file or transient error
 * must not abort the surrounding deletion.
 *
 * Reference-safe: import-time content dedup (services/cellarImport.js) can point
 * TWO BottleImage docs at the same file on disk (so we don't re-store an image
 * the user already has). Before unlinking a file we therefore check whether any
 * OTHER BottleImage still references that URL, and skip the unlink if so — so
 * deleting one doc never orphans another doc's still-needed file. When the image
 * has no other references (the common case), behaviour is unchanged.
 */
async function unlinkImageFiles(image) {
  if (!image) return;
  for (const url of [image.originalUrl, image.processedUrl]) {
    if (!url || typeof url !== 'string' || !url.startsWith('/api/uploads/')) continue;
    try {
      const stillReferenced = await BottleImage.countDocuments({
        _id: { $ne: image._id },
        $or: [{ originalUrl: url }, { processedUrl: url }],
      });
      if (stillReferenced > 0) continue; // another image doc shares this file — keep it
    } catch (err) {
      // If the reference check fails, fall through and unlink as before — the
      // pre-dedup behaviour. Shared files are rare; orphaning a file is worse
      // than the (very unlikely) case of removing a still-referenced one.
      console.warn(`[images] reference check failed for ${url}:`, err.message);
    }
    try {
      await fs.promises.unlink(safeUploadPath(url.replace('/api/uploads/', '')));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[images] could not unlink ${url}:`, err.message);
      }
    }
  }
}

async function processImage(imageId) {
  const image = await BottleImage.findById(imageId);
  if (!image || image.status !== 'uploaded') return;

  // Mark as processing
  image.status = 'processing';
  await image.save();

  try {
    // Read original file from disk
    const originalPath = safeUploadPath(image.originalUrl.replace('/api/uploads/', ''));
    const fileBuffer = fs.readFileSync(originalPath);

    // Build multipart form data using Node 20 built-in fetch
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
    formData.append('image', blob, 'input.jpg');

    const response = await fetch(`${REMBG_URL}/remove-bg`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120000) // 2 min timeout
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`rembg returned ${response.status}: ${errText}`);
    }

    // Save processed PNG
    const resultBuffer = Buffer.from(await response.arrayBuffer());
    const basename = path.basename(image.originalUrl, path.extname(image.originalUrl));
    const processedFilename = `${basename}.png`;
    const processedPath = path.join(PROCESSED_DIR, processedFilename);

    fs.writeFileSync(processedPath, resultBuffer);

    // Update document. The processed (cropped) image is now the version we keep
    // and export, so the dedup hash is computed from it (overriding the
    // original-bytes hash stamped at upload) — keeping it consistent with what a
    // cellar export carries and re-imports.
    image.processedUrl = `/api/uploads/processed/${processedFilename}`;
    image.status = 'processed';
    image.contentHash = hashImageBytes(resultBuffer);
    await image.save();

    console.log(`Image ${imageId} processed successfully`);
  } catch (error) {
    console.error(`Image processing failed for ${imageId}:`, error.message);
    // Revert to uploaded so it can be retried
    image.status = 'uploaded';
    await image.save();
  }
}

async function reprocessAllImages() {
  const images = await BottleImage.find({
    status: { $in: ['processed', 'approved'] },
    originalUrl: { $exists: true }
  });

  console.log(`Re-processing ${images.length} images...`);

  for (const image of images) {
    try {
      const originalPath = safeUploadPath(image.originalUrl.replace('/api/uploads/', ''));
      if (!fs.existsSync(originalPath)) {
        console.log(`Skipping ${image._id}: original file not found`);
        continue;
      }

      const fileBuffer = fs.readFileSync(originalPath);
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
      formData.append('image', blob, 'input.jpg');

      const response = await fetch(`${REMBG_URL}/remove-bg`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(120000)
      });

      if (!response.ok) {
        console.log(`Skipping ${image._id}: rembg error ${response.status}`);
        continue;
      }

      const resultBuffer = Buffer.from(await response.arrayBuffer());
      const basename = path.basename(image.originalUrl, path.extname(image.originalUrl));
      const processedFilename = `${basename}.png`;
      const processedPath = path.join(PROCESSED_DIR, processedFilename);

      fs.writeFileSync(processedPath, resultBuffer);
      image.processedUrl = `/api/uploads/processed/${processedFilename}`;
      await image.save();

      console.log(`Re-processed ${image._id} successfully`);
    } catch (error) {
      console.error(`Re-process failed for ${image._id}:`, error.message);
    }
  }

  console.log('Re-processing complete');
}

/**
 * Clean up images stuck in 'processing' for more than 1 hour (likely failed silently)
 * and remove orphaned original files that have no matching database record.
 */
async function cleanupOrphanedImages() {
  try {
    // Reset images stuck in 'processing' for >1h back to 'uploaded'
    const stuckThreshold = new Date(Date.now() - 60 * 60 * 1000);
    const result = await BottleImage.updateMany(
      { status: 'processing', updatedAt: { $lt: stuckThreshold } },
      { status: 'uploaded' }
    );
    if (result.modifiedCount > 0) {
      console.log(`[cleanup] Reset ${result.modifiedCount} stuck processing images to uploaded`);
    }

    // Remove orphaned files from disk (originals with no DB record)
    const ORIGINALS_DIR = path.join(UPLOADS_ROOT, 'originals');
    if (!fs.existsSync(ORIGINALS_DIR)) return;

    // originalUrl is null for approved/rejected images (their file was already
    // deleted) — path.basename(null) used to throw here, which silently
    // disabled the orphan sweep forever once any image had been moderated.
    const files = await fs.promises.readdir(ORIGINALS_DIR);
    const dbImages = await BottleImage.find({ originalUrl: { $ne: null } }, 'originalUrl').lean();
    const knownFiles = new Set(dbImages.map(img => path.basename(img.originalUrl)));

    let removed = 0;
    for (const file of files) {
      if (knownFiles.has(file)) continue;

      // Only remove files older than 1 hour to avoid racing with in-progress
      // uploads. Async fs — the sync walk held the event loop for the whole
      // directory scan, freezing the API every hour as uploads accumulate.
      const filePath = path.join(ORIGINALS_DIR, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
          await fs.promises.unlink(filePath);
          removed++;
        }
      } catch {
        // File vanished mid-sweep (e.g. processed and cleaned) — fine
      }
    }
    if (removed > 0) {
      console.log(`[cleanup] Removed ${removed} orphaned original files`);
    }
  } catch (error) {
    console.error('[cleanup] Image cleanup failed:', error.message);
  }
}

module.exports = { processImage, reprocessAllImages, cleanupOrphanedImages, safeUploadPath, unlinkImageFiles, hashImageBytes };
