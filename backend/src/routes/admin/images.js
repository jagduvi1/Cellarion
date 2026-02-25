const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const BottleImage = require('../../models/BottleImage');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { reprocessAllImages } = require('../../services/imageProcessor');
const { logAudit } = require('../../services/audit');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/images - List images with optional status filter
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const parsedPage = parseInt(page) || 1;
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (parsedPage - 1) * parsedLimit;

    const [images, total] = await Promise.all([
      BottleImage.find(filter)
        .populate({
          path: 'bottle',
          populate: { path: 'wineDefinition', select: 'name producer type' }
        })
        .populate('wineDefinition', 'name producer type')
        .populate('uploadedBy', 'username')
        .populate('reviewedBy', 'username')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parsedLimit),
      BottleImage.countDocuments(filter)
    ]);

    res.json({ images, total, page: parsedPage, limit: parsedLimit });
  } catch (error) {
    console.error('Get admin images error:', error);
    res.status(500).json({ error: 'Failed to get images' });
  }
});

// PUT /api/admin/images/:id/approve
router.put('/:id/approve', async (req, res) => {
  try {
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (!['processed', 'uploaded'].includes(image.status)) {
      return res.status(400).json({ error: 'Image cannot be approved in current state' });
    }

    image.status = 'approved';
    image.reviewedBy = req.user.id;
    image.reviewedAt = new Date();
    await image.save();

    // Auto-assign as wine image if the wine doesn't already have one
    const wineDefId = image.wineDefinition;
    if (wineDefId) {
      const wine = await WineDefinition.findById(wineDefId);
      if (wine && !wine.image) {
        await BottleImage.updateMany(
          { wineDefinition: wineDefId, assignedToWine: true },
          { assignedToWine: false }
        );
        image.assignedToWine = true;
        await image.save();

        const imageUrl = image.processedUrl || image.originalUrl;
        await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl });
        searchService.indexWine(wineDefId);
      }
    }

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.approve',
      { type: 'image', id: image._id },
      { wineDefinitionId: image.wineDefinition }
    );

    res.json({ image });
  } catch (error) {
    console.error('Approve image error:', error);
    res.status(500).json({ error: 'Failed to approve image' });
  }
});

// PUT /api/admin/images/:id/reject
router.put('/:id/reject', async (req, res) => {
  try {
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    image.status = 'rejected';
    image.reviewedBy = req.user.id;
    image.reviewedAt = new Date();
    await image.save();

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' }
    ]);

    logAudit(req, 'admin.image.reject',
      { type: 'image', id: image._id },
      {}
    );

    res.json({ image });
  } catch (error) {
    console.error('Reject image error:', error);
    res.status(500).json({ error: 'Failed to reject image' });
  }
});

// PUT /api/admin/images/:id/assign-to-wine - Set as official wine image
router.put('/:id/assign-to-wine', async (req, res) => {
  try {
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (image.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved images can be assigned to a wine' });
    }

    const wineDefId = req.body.wineDefinitionId || image.wineDefinition;
    if (!wineDefId) {
      return res.status(400).json({ error: 'No wine definition to assign to' });
    }

    // Unset previous assignment for this wine
    await BottleImage.updateMany(
      { wineDefinition: wineDefId, assignedToWine: true },
      { assignedToWine: false }
    );

    // Set this image as official
    image.assignedToWine = true;
    image.wineDefinition = wineDefId;
    await image.save();

    // Update WineDefinition.image to the processed URL (or original if not processed)
    const imageUrl = image.processedUrl || image.originalUrl;
    await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl });

    // Update search index
    searchService.indexWine(wineDefId);

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.assign',
      { type: 'image', id: image._id },
      { wineDefinitionId: wineDefId }
    );

    res.json({ image });
  } catch (error) {
    console.error('Assign image error:', error);
    res.status(500).json({ error: 'Failed to assign image to wine' });
  }
});

// POST /api/admin/images/reprocess-all - Re-process all images through updated pipeline
router.post('/reprocess-all', async (req, res) => {
  res.json({ message: 'Re-processing started' });
  reprocessAllImages().catch(err =>
    console.error('Reprocess-all error:', err)
  );
});

module.exports = router;
