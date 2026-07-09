const path = require('path');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { upload, ORIGINALS_DIR } = require('../config/upload');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { rateLimitKey } = require('../utils/clientIp');
const { getCellarRole } = require('../utils/cellarAccess');
const { processImage, hashImageBytes } = require('../services/imageProcessor');
const { stripImageMetadata, sanitizeImageBuffer } = require('../services/imageSanitizer');
const { stripHtml } = require('../utils/sanitize');
const { isValidId } = require('../utils/validation');
const rateLimitsConfig = require('../config/rateLimits');
const { logAudit } = require('../services/audit');

/**
 * Safely remove an uploaded file, but only if it resides within the expected
 * upload directory.  This prevents path-traversal attacks where a crafted
 * filename could trick the server into deleting arbitrary files.
 */
function safeUnlink(filePath) {
  const resolved = path.resolve(filePath);
  const originalsPrefix = path.resolve(ORIGINALS_DIR) + path.sep;
  if (!resolved.startsWith(originalsPrefix)) {
    console.error('Refusing to delete file outside upload directory:', resolved);
    return;
  }
  fs.unlinkSync(resolved);
}

const MAX_IMAGES_PER_BOTTLE = 20;

// Rate limiter for background removal preview — 5 requests per minute per user
const bgRemovalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many background removal requests, please try again later' });
  }
});

// Per-user upload cap on /upload. The per-bottle MAX_IMAGES_PER_BOTTLE limits
// per-resource growth, but doesn't stop a user creating bottles + uploading
// in a loop to fill the disk. Keyed on req.user.id (not IP) so an attacker
// rotating IPs can't bypass.
const imageUploadLimiter = rateLimit({
  // windowMs is read once at limiter creation (express-rate-limit doesn't
  // support a functional windowMs in v7). Matches the chatBurst pattern.
  windowMs: 60 * 60 * 1000,
  max:      () => rateLimitsConfig.get().imageUploadBurst.max,
  keyGenerator: (req) => String(req.user?.id || ''),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'image-upload', userId: req.user?.id });
    res.status(429).json({ error: 'Too many image uploads. Please wait and try again later.' });
  }
});

const MAX_IMAGE_DIMENSION = 8000; // max width or height in pixels

// Validate image file by checking magic bytes (first 12 bytes)
function validateImageMagicBytes(filePath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;

  return false;
}

/**
 * Read image dimensions from file headers without decoding the full image.
 * Returns { width, height } or null if dimensions cannot be determined.
 */
function getImageDimensions(filePath) {
  try {
    // Ensure filePath is within the expected upload directory
    const resolved = path.resolve(filePath);
    const originalsPrefix = path.resolve(ORIGINALS_DIR) + path.sep;
    if (!resolved.startsWith(originalsPrefix)) return null;

    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(30);
      fs.readSync(fd, header, 0, 30, 0);

      // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian in IHDR)
      if (header[0] === 0x89 && header[1] === 0x50) {
        return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
      }

      // WebP: VP8 width/height at fixed offsets in RIFF container
      if (header[0] === 0x52 && header[1] === 0x49 && header[8] === 0x57) {
        // VP8 lossy
        if (header[12] === 0x56 && header[13] === 0x50 && header[14] === 0x38 && header[15] === 0x20) {
          const vp8 = Buffer.alloc(10);
          fs.readSync(fd, vp8, 0, 10, 20);
          // Frame tag at offset 3, then width/height as little-endian 16-bit
          return { width: vp8.readUInt16LE(6) & 0x3FFF, height: vp8.readUInt16LE(8) & 0x3FFF };
        }
        // VP8L lossless
        if (header[12] === 0x56 && header[13] === 0x50 && header[14] === 0x38 && header[15] === 0x4C) {
          const vp8l = Buffer.alloc(5);
          fs.readSync(fd, vp8l, 0, 5, 21);
          const bits = vp8l.readUInt32LE(0);
          return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
        }
        return null;
      }

      // JPEG: scan for SOF0/SOF2 markers to find dimensions
      if (header[0] === 0xFF && header[1] === 0xD8) {
        const buf = Buffer.alloc(65536);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        let pos = 2;
        while (pos < bytesRead - 8) {
          if (buf[pos] !== 0xFF) { pos++; continue; }
          const marker = buf[pos + 1];
          // SOF0 (0xC0) or SOF2 (0xC2) — baseline or progressive
          if (marker === 0xC0 || marker === 0xC2) {
            return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
          }
          // Skip marker segment
          const segLen = buf.readUInt16BE(pos + 2);
          pos += 2 + segLen;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // If we can't read dimensions, let the upload proceed (fail open for dimension check)
  }
  return null;
}

const router = express.Router();

// Wrap multer so its errors become 4xx instead of bubbling to the central
// handler, which returns 500 and masks the reason in production — the user
// gets zero indication their photo was too big or the wrong format. Same
// pattern as cellarImport.js's handleUpload.
function handleImageUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Image too large (max 10 MB)' });
      return res.status(400).json({ error: err.message || 'Invalid image upload' });
    }
    next();
  });
}

// POST /api/images/upload - Upload image for a bottle or wine definition
router.post('/upload', requireAuth, imageUploadLimiter, handleImageUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Validate magic bytes to confirm the file is actually an image
    if (!validateImageMagicBytes(req.file.path)) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'File content does not match a supported image format (JPEG, PNG, or WebP)' });
    }

    // Validate image dimensions to prevent pixel flood DoS
    const dims = getImageDimensions(req.file.path);
    if (dims && (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION)) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: `Image dimensions too large (max ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION} pixels)` });
    }

    const { bottleId, wineDefinitionId, credit } = req.body;

    // Verify bottle ownership and image count if bottleId is provided
    if (bottleId) {
      if (!mongoose.Types.ObjectId.isValid(bottleId)) {
        safeUnlink(req.file.path);
        return res.status(400).json({ error: 'Invalid bottleId' });
      }
      const bottle = await Bottle.findById(bottleId);
      if (!bottle) {
        safeUnlink(req.file.path);
        return res.status(404).json({ error: 'Bottle not found' });
      }
      const cellar = await Cellar.findById(bottle.cellar);
      const cellarRole = cellar ? getCellarRole(cellar, req.user.id) : null;
      if (!cellarRole || cellarRole === 'viewer') {
        safeUnlink(req.file.path);
        return res.status(403).json({ error: 'Not authorized to upload images for this bottle' });
      }
      const imageCount = await BottleImage.countDocuments({ bottle: bottleId });
      if (imageCount >= MAX_IMAGES_PER_BOTTLE) {
        safeUnlink(req.file.path);
        return res.status(400).json({ error: `Maximum of ${MAX_IMAGES_PER_BOTTLE} images per bottle reached` });
      }
    }

    // Only admins can set image credits (wine library images)
    const isAdmin = req.user.roles && req.user.roles.includes('admin');
    const sanitizedCredit = (isAdmin && credit && typeof credit === 'string')
      ? stripHtml(credit).slice(0, 200)
      : null;

    if (wineDefinitionId && !mongoose.isValidObjectId(String(wineDefinitionId))) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Invalid wine definition ID' });
    }

    // Re-encode in place to strip EXIF/GPS and other metadata before the
    // file becomes reachable under /api/uploads (phone photos embed the
    // owner's location). Decode failure also catches files that slipped
    // past the header checks.
    try {
      await stripImageMetadata(req.file.path);
    } catch (err) {
      console.error('Image sanitization failed:', err.message);
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Image could not be processed — the file may be corrupt or too large' });
    }

    // Content hash of the stored bytes, so a later cellar export re-imported by
    // this user dedups against the image they already have instead of writing a
    // copy (see services/cellarImport.js). Stamped from the original here; once
    // background removal finishes, processImage refreshes it from the cropped
    // bytes (the version that actually gets exported). Best-effort — a hash
    // failure must never block the upload.
    let contentHash = null;
    try {
      // Re-derive the path from the fixed uploads dir + basename so it's provably
      // confined there (multer already names the file with a random UUID; this also
      // satisfies static path-injection analysis).
      const storedPath = path.join(ORIGINALS_DIR, path.basename(req.file.path));
      contentHash = hashImageBytes(fs.readFileSync(storedPath));
    } catch (err) {
      console.warn('Image content-hash failed (non-fatal):', err.message);
    }

    const image = new BottleImage({
      bottle: bottleId || null,
      wineDefinition: wineDefinitionId ? String(wineDefinitionId) : null,
      uploadedBy: req.user.id,
      originalUrl: `/api/uploads/originals/${req.file.filename}`,
      status: 'uploaded',
      credit: sanitizedCredit || null,
      contentHash
    });

    await image.save();

    // Fire-and-forget background removal
    processImage(image._id).catch(err =>
      console.error('Background processing error:', err.message)
    );

    res.status(201).json({ image });
  } catch (error) {
    console.error('Image upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// GET /api/images/bottle/:bottleId - Get images for a bottle
router.get('/bottle/:bottleId', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.bottleId)) return res.status(400).json({ error: 'Invalid ID' });

    // Verify bottle access (owner or shared cellar viewer+)
    const bottle = await Bottle.findById(req.params.bottleId);
    if (!bottle) {
      return res.status(404).json({ error: 'Bottle not found' });
    }
    const cellar = await Cellar.findById(bottle.cellar);
    const cellarRole = cellar ? getCellarRole(cellar, req.user.id) : null;
    if (!cellarRole) {
      return res.status(404).json({ error: 'Bottle not found' });
    }

    // Fetch bottle-specific images:
    // - Public approved images for everyone
    // - Private approved images only for the uploader
    // - Non-approved images only for the uploader
    const bottleImages = await BottleImage.find({
      bottle: req.params.bottleId,
      $or: [
        { status: 'approved', visibility: 'public' },
        { uploadedBy: req.user.id }
      ]
    }).sort({ createdAt: -1 });

    // Also fetch public approved wine-level images so the user can pick any as default
    let wineImages = [];
    if (bottle.wineDefinition) {
      const bottleImageIds = new Set(bottleImages.map(img => img._id.toString()));
      wineImages = await BottleImage.find({
        wineDefinition: bottle.wineDefinition,
        status: 'approved',
        visibility: 'public'
      }).sort({ assignedToWine: -1, createdAt: -1 });
      // Exclude any that are already in the bottle-specific list
      wineImages = wineImages.filter(img => !bottleImageIds.has(img._id.toString()));
    }

    const images = [...bottleImages, ...wineImages];

    // Sort default image first if the bottle has one set
    if (bottle.defaultImage) {
      const defaultId = bottle.defaultImage.toString();
      images.sort((a, b) => {
        const aIsDefault = a._id.toString() === defaultId ? -1 : 0;
        const bIsDefault = b._id.toString() === defaultId ? -1 : 0;
        return aIsDefault - bIsDefault;
      });
    }

    res.json({ images, defaultImageId: bottle.defaultImage || null });
  } catch (error) {
    console.error('Get bottle images error:', error);
    res.status(500).json({ error: 'Failed to get images' });
  }
});

// GET /api/images/wine/:wineDefinitionId - Get images for a wine definition
// ?all=true (admin only) includes all non-rejected images
router.get('/wine/:wineDefinitionId', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.wineDefinitionId)) return res.status(400).json({ error: 'Invalid ID' });

    const isAdmin = req.user.roles && req.user.roles.includes('admin');
    const showAll = req.query.all === 'true' && isAdmin;

    const filter = {
      wineDefinition: req.params.wineDefinitionId,
      ...(showAll
        ? { status: { $ne: 'rejected' } }
        : { status: 'approved', visibility: 'public' })
    };

    const images = await BottleImage.find(filter)
      .sort({ assignedToWine: -1, createdAt: -1 });

    res.json({ images });
  } catch (error) {
    console.error('Get wine images error:', error);
    res.status(500).json({ error: 'Failed to get images' });
  }
});

// GET /api/images/:id - Get single image by ID (for polling processing status)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    let authorized = false;

    // User uploaded the image
    if (image.uploadedBy.toString() === req.user.id) {
      authorized = true;
    }

    // Image is approved AND public (visible to all authenticated users). An
    // approved-but-private image stays restricted to its uploader / bottle-owner
    // / cellar members handled below — matches the list endpoints, which gate on
    // { status: 'approved', visibility: 'public' }.
    if (!authorized && image.status === 'approved' && image.visibility === 'public') {
      authorized = true;
    }

    // User owns the bottle this image is attached to, or has cellar access
    if (!authorized && image.bottle) {
      const bottle = await Bottle.findById(image.bottle);
      if (bottle && bottle.user.toString() === req.user.id) {
        authorized = true;
      }
      if (!authorized && bottle && bottle.cellar) {
        const cellar = await Cellar.findById(bottle.cellar);
        if (cellar && getCellarRole(cellar, req.user.id)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.json({ image });
  } catch (error) {
    console.error('Get image error:', error);
    res.status(500).json({ error: 'Failed to get image' });
  }
});

// POST /api/images/remove-bg-preview - Remove background from a base64 image (no DB storage)
router.post('/remove-bg-preview', requireAuth, bgRemovalLimiter, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image (base64 data URL) is required' });
    }

    // Strip data URL prefix and decode — only allow known image MIME types
    const mimeMatch = image.match(/^data:image\/(jpeg|png|webp);base64,/);
    if (!mimeMatch) {
      return res.status(400).json({ error: 'image must be a base64 data URL with MIME type image/jpeg, image/png, or image/webp' });
    }
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Fail-closed pixel/format guard + metadata strip before handing the image
    // to the single-worker rembg service. Without it a small compressed payload
    // can decode to a 100M+ pixel "decompression bomb" that ties up rembg for
    // the full timeout (DoS). Mirrors the /upload path, which sanitises on disk.
    let safeBuffer;
    try {
      safeBuffer = await sanitizeImageBuffer(buffer);
    } catch {
      return res.status(400).json({ error: 'Image is too large or not a valid JPEG, PNG, or WebP' });
    }

    const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';
    const formData = new FormData();
    const blob = new Blob([safeBuffer], { type: 'image/jpeg' });
    formData.append('image', blob, 'input.jpg');

    const response = await fetch(`${REMBG_URL}/remove-bg`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Background removal service failed' });
    }

    const resultBuffer = Buffer.from(await response.arrayBuffer());
    const processedBase64 = `data:image/png;base64,${resultBuffer.toString('base64')}`;

    res.json({ processedImage: processedBase64 });
  } catch (error) {
    console.error('BG preview removal error:', error.message);
    res.status(500).json({ error: 'Failed to remove background' });
  }
});

// POST /api/images/link-to-bottle - Link uploaded images to a bottle after creation
router.post('/link-to-bottle', requireAuth, async (req, res) => {
  try {
    const { bottleId, imageIds } = req.body;

    if (!bottleId || !imageIds || !Array.isArray(imageIds)) {
      return res.status(400).json({ error: 'bottleId and imageIds array are required' });
    }
    if (imageIds.length > MAX_IMAGES_PER_BOTTLE) {
      return res.status(400).json({ error: `Maximum of ${MAX_IMAGES_PER_BOTTLE} images per bottle` });
    }
    if (!isValidId(bottleId) || !imageIds.every(id => isValidId(id))) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    // Verify cellar access — bottles are owned by the cellar owner, so shared-cellar
    // editors must be allowed to link the images they uploaded (mirrors /upload).
    const bottle = await Bottle.findById(bottleId);
    if (!bottle) {
      return res.status(404).json({ error: 'Bottle not found' });
    }
    const cellar = await Cellar.findById(bottle.cellar);
    if (!cellar) {
      return res.status(404).json({ error: 'Bottle not found' });
    }
    const cellarRole = getCellarRole(cellar, req.user.id);
    if (!cellarRole || cellarRole === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to link images to this bottle' });
    }

    // Enforce the same per-bottle cap /upload applies — the normal AddBottle
    // flow uploads bottleless images then links here, which used to bypass it.
    const existingCount = await BottleImage.countDocuments({ bottle: bottleId });
    if (existingCount + imageIds.length > MAX_IMAGES_PER_BOTTLE) {
      return res.status(400).json({ error: `Maximum of ${MAX_IMAGES_PER_BOTTLE} images per bottle reached` });
    }

    await BottleImage.updateMany(
      { _id: { $in: imageIds }, uploadedBy: req.user.id },
      { bottle: bottleId }
    );

    res.json({ message: 'Images linked to bottle' });
  } catch (error) {
    console.error('Link images error:', error);
    res.status(500).json({ error: 'Failed to link images' });
  }
});

// POST /api/images/:id/retry - Retry background removal
router.post('/:id/retry', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (image.uploadedBy.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (image.status !== 'uploaded') {
      return res.status(400).json({ error: 'Image is not in uploaded state' });
    }

    processImage(image._id).catch(err =>
      console.error('Retry processing error:', err.message)
    );

    res.json({ message: 'Processing restarted' });
  } catch (error) {
    console.error('Retry error:', error);
    res.status(500).json({ error: 'Failed to retry processing' });
  }
});

module.exports = router;
