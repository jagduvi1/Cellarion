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
 * Unlink ONE upload file unless another BottleImage still references it.
 *
 * Reference-safe: import-time content dedup (services/cellarImport.js) can point
 * TWO BottleImage docs at the same file on disk (so we don't re-store an image
 * the user already has). Before unlinking a file we therefore check whether any
 * OTHER BottleImage still references that URL, and skip the unlink if so — so
 * deleting one doc never orphans another doc's still-needed file. When the image
 * has no other references (the common case), the file is simply removed.
 *
 * Never throws — a missing file or transient error must not abort the
 * surrounding operation. Returns true when the file is gone (unlinked, or was
 * already missing), false when it was kept for another document.
 */
async function unlinkIfUnreferenced(imageId, url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/api/uploads/')) return true;
  try {
    const stillReferenced = await BottleImage.countDocuments({
      _id: { $ne: imageId },
      $or: [{ originalUrl: url }, { processedUrl: url }],
    });
    if (stillReferenced > 0) return false; // another image doc shares this file — keep it
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
  return true;
}

/**
 * Best-effort unlink of a BottleImage's on-disk files (original + processed).
 * Used by GDPR erasure so the underlying files don't outlive the DB rows that
 * are their only reference. Never throws — a missing file or transient error
 * must not abort the surrounding deletion.
 */
async function unlinkImageFiles(image) {
  if (!image) return;
  for (const url of [image.originalUrl, image.processedUrl]) {
    await unlinkIfUnreferenced(image._id, url);
  }
}

/**
 * Drop the ORIGINAL upload once background removal has produced the processed
 * file — the processed image is the only copy Cellarion keeps.
 *
 * Support ticket 2026-09-03: a user's cellar showed photos "including the
 * background", served from /api/uploads/originals/. That frame is the raw
 * photo — a kitchen table, a hand, a face — and nothing needs it once rembg
 * has run: every display path prefers processedUrl, the cellar export ships
 * the processed file, and the only retry path (POST /api/images/:id/retry)
 * exists for images that have NO processed file yet. Keeping it was pure
 * exposure. Until now only an admin approval deleted the original, so a
 * private photo — the common case — kept its raw frame on disk for good.
 *
 * Skipped when the original IS the kept file (a keepBackground row, where
 * processedUrl === originalUrl — see models/BottleImage) and when there is no
 * processed file at all (a failed rembg run still needs its source for the
 * retry; an imported never-cropped photo has nothing else). Reference-safe
 * like everything else here, and never throws: a stray unlink failure must not
 * fail the processing job that just succeeded — the hourly orphan sweep
 * (cleanupOrphanedImages) picks up a file nothing references any more.
 *
 * Nulls originalUrl in the DB directly (not via image.save()) so a caller
 * holding a stale document snapshot cannot resurrect the URL, and mirrors the
 * change onto the in-memory doc for callers that go on to save it.
 */
async function discardOriginal(image) {
  if (!image || !image.originalUrl || !image.processedUrl) return;
  if (image.originalUrl === image.processedUrl) return;
  const url = image.originalUrl;
  await unlinkIfUnreferenced(image._id, url);
  try {
    await BottleImage.updateOne({ _id: image._id, originalUrl: url }, { $set: { originalUrl: null } });
  } catch (err) {
    console.warn(`[images] could not clear originalUrl for ${image._id}:`, err.message);
  }
  image.originalUrl = null;
}

async function processImage(imageId) {
  const image = await BottleImage.findById(imageId);
  if (!image || image.status !== 'uploaded') return;

  // The uploader opted out of background removal (label-only photo, product
  // shot — see models/BottleImage.keepBackground). The original is the kept
  // image; a retry or a stray 'uploaded' row just settles it without rembg.
  if (image.keepBackground) {
    image.processedUrl = image.originalUrl;
    image.status = 'processed';
    await image.save();
    return;
  }

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

    // Official wine images (assignedToWine) may have been APPROVED before (or
    // while) this job ran — admin-direct uploads are, and a web approval of an
    // 'uploaded' image races it. Re-read the flag (this job's doc snapshot
    // predates the approval), keep the approval, and upgrade the WINE's display
    // image from the original to the clean processed version — previously an
    // early approval pinned originalUrl on the wine forever.
    const official = await BottleImage.findById(imageId).select('assignedToWine wineDefinition status');
    if (official?.assignedToWine && official.wineDefinition) {
      if (official.status !== 'approved') {
        await BottleImage.updateOne({ _id: imageId }, { status: 'approved' });
      }
      const WineDefinition = require('../models/WineDefinition');
      await WineDefinition.findByIdAndUpdate(official.wineDefinition, { image: image.processedUrl });
      require('./search').indexWine(official.wineDefinition);
    }

    // The processed file is now the only copy we keep — the raw frame goes.
    // AFTER the wine-image upgrade above, so WineDefinition.image never points
    // at a file that has just been deleted, even for a moment.
    await discardOriginal(image);

    console.log(`Image ${imageId} processed successfully`);
  } catch (error) {
    console.error(`Image processing failed for ${imageId}:`, error.message);
    // Revert to uploaded so it can be retried — but never demote an official
    // (assignedToWine) image's approval; reprocessAllImages retries those too.
    image.status = image.assignedToWine ? 'approved' : 'uploaded';
    await image.save();
  }
}

// reprocessAllImages (admin "re-run rembg over every image") used to live here.
// It went with the retained originals: a processed image no longer has a
// source frame to re-run, by design (see discardOriginal). An image whose rembg
// run FAILED keeps its original and is re-run via POST /api/images/:id/retry.

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

    // originalUrl is null for every processed image (discardOriginal) and for
    // rejected ones — path.basename(null) used to throw here, which silently
    // disabled the orphan sweep forever once any image had been moderated.
    // A file whose unlink failed in discardOriginal lands here too: nothing
    // references it any more, so it is an orphan.
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

module.exports = { processImage, cleanupOrphanedImages, safeUploadPath, unlinkImageFiles, unlinkIfUnreferenced, discardOriginal, hashImageBytes };
