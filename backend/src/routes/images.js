const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../config/upload');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const { processImage } = require('../services/imageProcessor');

const router = express.Router();

// POST /api/images/upload - Upload image for a bottle
router.post('/upload', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const { bottleId, wineDefinitionId } = req.body;

    // Verify bottle ownership if bottleId is provided
    if (bottleId) {
      const bottle = await Bottle.findOne({ _id: bottleId, user: req.user.id });
      if (!bottle) {
        return res.status(404).json({ error: 'Bottle not found' });
      }
    }

    const image = new BottleImage({
      bottle: bottleId || null,
      wineDefinition: wineDefinitionId || null,
      uploadedBy: req.user.id,
      originalUrl: `/api/uploads/originals/${req.file.filename}`,
      status: 'uploaded'
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
    // Only allow uploader to see their own images, or anyone to see approved images
    if (image.uploadedBy.toString() !== req.user.id && image.status !== 'approved') {
      return res.status(404).json({ error: 'Image not found' });
    }
    res.json({ image });
  } catch (error) {
    console.error('Get image error:', error);
    res.status(500).json({ error: 'Failed to get image' });
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
