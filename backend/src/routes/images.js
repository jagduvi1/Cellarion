const express = require('express');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../config/upload');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { getCellarRole } = require('../utils/cellarAccess');
const { processImage } = require('../services/imageProcessor');
const { stripHtml } = require('../utils/sanitize');

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
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File content does not match a supported image format (JPEG, PNG, or WebP)' });
    }

    const { bottleId, wineDefinitionId, credit } = req.body;

    // Verify bottle ownership if bottleId is provided
    if (bottleId) {
      const bottle = await Bottle.findOne({ _id: bottleId, user: req.user.id });
      if (!bottle) {
        return res.status(404).json({ error: 'Bottle not found' });
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
    // Verify bottle ownership
    const bottle = await Bottle.findOne({ _id: req.params.bottleId, user: req.user.id });
    if (!bottle) {
      return res.status(404).json({ error: 'Bottle not found' });
    }

    const images = await BottleImage.find({
      bottle: req.params.bottleId,
      status: { $ne: 'rejected' }
    }).sort({ createdAt: -1 });

    res.json({ images });
  } catch (error) {
    console.error('Get bottle images error:', error);
    res.status(500).json({ error: 'Failed to get images' });
  }
});

// GET /api/images/wine/:wineDefinitionId - Get images for a wine definition
router.get('/wine/:wineDefinitionId', requireAuth, async (req, res) => {
  try {
    const images = await BottleImage.find({
      wineDefinition: req.params.wineDefinitionId,
      status: 'approved'
    }).sort({ assignedToWine: -1, createdAt: -1 });

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
router.post('/remove-bg-preview', requireAuth, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image (base64 data URL) is required' });
    }

    // Strip data URL prefix and decode
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
