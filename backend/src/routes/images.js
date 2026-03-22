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
const { getCellarRole } = require('../utils/cellarAccess');
const { processImage } = require('../services/imageProcessor');
const { stripHtml } = require('../utils/sanitize');

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
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many background removal requests, please try again later' });
  }
});

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

const router = express.Router();

// POST /api/images/upload - Upload image for a bottle or wine definition
router.post('/upload', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Validate magic bytes to confirm the file is actually an image
    if (!validateImageMagicBytes(req.file.path)) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'File content does not match a supported image format (JPEG, PNG, or WebP)' });
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

    const image = new BottleImage({
      bottle: bottleId || null,
      wineDefinition: wineDefinitionId || null,
      uploadedBy: req.user.id,
      originalUrl: `/api/uploads/originals/${req.file.filename}`,
      status: 'uploaded',
      credit: sanitizedCredit || null
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

    // Fetch bottle-specific images (all non-rejected statuses)
    const bottleImages = await BottleImage.find({
      bottle: req.params.bottleId,
      status: { $ne: 'rejected' }
    }).sort({ createdAt: -1 });

    // Also fetch approved wine-level images so the user can pick any as default
    let wineImages = [];
    if (bottle.wineDefinition) {
      const bottleImageIds = new Set(bottleImages.map(img => img._id.toString()));
      wineImages = await BottleImage.find({
        wineDefinition: bottle.wineDefinition,
        status: 'approved'
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
    const isAdmin = req.user.roles && req.user.roles.includes('admin');
    const showAll = req.query.all === 'true' && isAdmin;

    const filter = {
      wineDefinition: req.params.wineDefinitionId,
      status: showAll ? { $ne: 'rejected' } : 'approved'
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
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    let authorized = false;

    // User uploaded the image
    if (image.uploadedBy.toString() === req.user.id) {
      authorized = true;
    }

    // Image is approved (visible to all authenticated users)
    if (!authorized && image.status === 'approved') {
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

    const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';
    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'image/jpeg' });
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

    // Verify bottle ownership
    const bottle = await Bottle.findOne({ _id: bottleId, user: req.user.id });
    if (!bottle) {
      return res.status(404).json({ error: 'Bottle not found' });
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
