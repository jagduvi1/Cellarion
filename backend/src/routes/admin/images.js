const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const BottleImage = require('../../models/BottleImage');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { reprocessAllImages } = require('../../services/imageProcessor');
const { logAudit } = require('../../services/audit');
const { createNotification } = require('../../services/notifications');
const { parsePagination } = require('../../utils/pagination');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/images - List images with optional status filter
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 100 });
    const filter = {};
    const validStatuses = ['uploaded', 'processing', 'processed', 'approved', 'rejected'];
    if (status) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}` });
      }
      filter.status = status;
    }

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
        .skip(offset)
        .limit(limit),
      BottleImage.countDocuments(filter)
    ]);

    res.json({ images, total, page, limit });
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
    let approvedWine = null;
    if (wineDefId) {
      approvedWine = await WineDefinition.findById(wineDefId);
      if (approvedWine && !approvedWine.image) {
        await BottleImage.updateMany(
          { wineDefinition: wineDefId, assignedToWine: true },
          { assignedToWine: false }
        );
        image.assignedToWine = true;
        await image.save();

        const imageUrl = image.processedUrl || image.originalUrl;
        await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl, imageCredit: image.credit || null });
        searchService.indexWine(wineDefId);
      }
    }

    const wineLabel = approvedWine
      ? `"${approvedWine.name}" by ${approvedWine.producer}`
      : 'a wine';
    createNotification(
      image.uploadedBy,
      'image_approved',
      'Image approved',
      `Your image for ${wineLabel} has been approved.`,
      null
    );

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

    const rejectedWine = image.wineDefinition
      ? await WineDefinition.findById(image.wineDefinition).select('name producer').lean()
      : null;
    const rejectedWineLabel = rejectedWine
      ? `"${rejectedWine.name}" by ${rejectedWine.producer}`
      : 'a wine';
    createNotification(
      image.uploadedBy,
      'image_rejected',
      'Image rejected',
      `Your image for ${rejectedWineLabel} was rejected by an admin.`,
      null
    );

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

// PUT /api/admin/images/:id/unapprove - Revert approved image back to processed
router.put('/:id/unapprove', async (req, res) => {
  try {
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (image.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved images can be unapproved' });
    }

    // If image was assigned to a wine, remove the assignment
    if (image.assignedToWine && image.wineDefinition) {
      const wineDefId = image.wineDefinition;
      image.assignedToWine = false;

      // Clear the wine definition's image if it matches this image
      const imageUrl = image.processedUrl || image.originalUrl;
      const wine = await WineDefinition.findById(wineDefId);
      if (wine && wine.image === imageUrl) {
        wine.image = null;
        wine.imageCredit = null;
        await wine.save();
        searchService.indexWine(wineDefId);
      }
    }

    image.status = image.processedUrl ? 'processed' : 'uploaded';
    image.reviewedBy = req.user.id;
    image.reviewedAt = new Date();
    await image.save();

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.unapprove',
      { type: 'image', id: image._id },
      { wineDefinitionId: image.wineDefinition }
    );

    res.json({ image });
  } catch (error) {
    console.error('Unapprove image error:', error);
    res.status(500).json({ error: 'Failed to unapprove image' });
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
    await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl, imageCredit: image.credit || null });

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
