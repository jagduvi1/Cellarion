const path = require('path');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { upload, ORIGINALS_DIR } = require('../config/upload');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { rateLimitKey } = require('../utils/clientIp');
const { getCellarRole } = require('../utils/cellarAccess');
const { processImage } = require('../services/imageProcessor');
const { sanitizeImageBuffer } = require('../services/imageSanitizer');
const { ingestBottleImage } = require('../services/imageOps');
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

// Header-level magic-byte + dimension pre-checks used to live here. They are
// gone: the /upload route now hands the bytes to services/imageOps, whose
// sanitizeImageBuffer decodes-validates-and-strips in one fail-CLOSED step
// (the old dimension check failed OPEN on unreadable headers). The per-request
// MAX_IMAGES_PER_BOTTLE cap still lives here for the link-to-bottle route.

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
// requireNonDemo: image upload writes a 10 MB original to disk and spawns a
// rembg background-removal job (memory-heavy, shared with real users' label
// scans). The demo is JSON-only / zero-compute by design, so uploads are off.
//
// Validation/sanitisation/persistence live in services/imageOps.js — ONE
// implementation shared with the MCP attach_bottle_image tool, so the two
// surfaces cannot drift. This route keeps multer (streaming disk upload) and
// the authorization checks; the shared pipeline takes the bytes from there.
// Note: sanitizeImageBuffer enforces the pixel cap FAIL-CLOSED (the previous
// file-header dimension check failed open on unreadable headers).
router.post('/upload', requireAuth, requireNonDemo, imageUploadLimiter, handleImageUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const { bottleId, wineDefinitionId, credit } = req.body;

    // Verify bottle ownership if bottleId is provided (access is the route's
    // job; the per-bottle image cap lives in the shared pipeline).
    let bottle = null;
    if (bottleId) {
      if (!mongoose.Types.ObjectId.isValid(bottleId)) {
        safeUnlink(req.file.path);
        return res.status(400).json({ error: 'Invalid bottleId' });
      }
      bottle = await Bottle.findById(bottleId);
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
    }

    if (wineDefinitionId && !mongoose.isValidObjectId(String(wineDefinitionId))) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'Invalid wine definition ID' });
    }

    // Hand the bytes to the shared pipeline and drop the multer temp — the
    // pipeline persists a sanitised re-encode under its own random name.
    let buffer;
    try {
      buffer = fs.readFileSync(req.file.path);
    } finally {
      safeUnlink(req.file.path);
    }
    const result = await ingestBottleImage({
      buffer,
      userId: req.user.id,
      // Credit is gated INSIDE the shared pipeline (admin-only + stripHtml) —
      // one implementation with the MCP attach tool, so the gate can't drift.
      userRoles: req.user.roles,
      bottle,
      wineDefinitionId: wineDefinitionId ? String(wineDefinitionId) : null,
      credit,
    }, req);
    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    res.status(201).json({ image: result.image });
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
router.post('/remove-bg-preview', requireAuth, requireNonDemo, bgRemovalLimiter, async (req, res) => {
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
router.post('/:id/retry', requireAuth, requireNonDemo, async (req, res) => {
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
