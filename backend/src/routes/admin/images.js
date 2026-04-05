const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const BottleImage = require('../../models/BottleImage');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const fs = require('fs');
const { reprocessAllImages, safeUploadPath } = require('../../services/imageProcessor');
const { logAudit } = require('../../services/audit');
const { createNotification } = require('../../services/notifications');
const { incrementCred } = require('../../utils/cellarCred');
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

// Helper: delete the original file if a processed version exists
function deleteOriginalFile(image) {
  if (image.processedUrl && image.originalUrl) {
    try {
      fs.unlinkSync(safeUploadPath(image.originalUrl.replace('/api/uploads/', '')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Failed to delete original image:', err.message);
    }
    image.originalUrl = null;
  }
}

// PUT /api/admin/images/:id/approve
// Body: { visibility: 'private' | 'public' } — defaults to 'public'
router.put('/:id/approve', async (req, res) => {
  try {
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (!['processed', 'uploaded'].includes(image.status)) {
      return res.status(400).json({ error: 'Image cannot be approved in current state' });
    }

    const visibility = req.body.visibility || 'public';
    if (!['private', 'public'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be "private" or "public"' });
    }

    image.status = 'approved';
    image.visibility = visibility;
    image.reviewedBy = req.user.id;
    image.reviewedAt = new Date();
    deleteOriginalFile(image);
    await image.save();

    // Award Cellar Cred to the uploader
    incrementCred(image.uploadedBy, 'image_approved').catch(() => {});

    // Auto-assign as wine image if public and the wine doesn't already have one
    const wineDefId = image.wineDefinition;
    let approvedWine = null;
    if (visibility === 'public' && wineDefId) {
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
      { wineDefinitionId: image.wineDefinition, visibility }
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

    // Delete both original and processed files from disk
    for (const url of [image.originalUrl, image.processedUrl]) {
      if (!url) continue;
      try {
        fs.unlinkSync(safeUploadPath(url.replace('/api/uploads/', '')));
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('Failed to delete image file:', err.message);
      }
    }
    image.originalUrl = null;
    image.processedUrl = null;
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

    // Award Cellar Cred for official wine image assignment
    incrementCred(image.uploadedBy, 'image_assigned_official').catch(() => {});

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

// PUT /api/admin/images/:id/visibility - Change visibility of an approved image
router.put('/:id/visibility', async (req, res) => {
  try {
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (image.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved images can change visibility' });
    }

    const { visibility } = req.body;
    if (!['private', 'public'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be "private" or "public"' });
    }

    // If changing to private, unassign from wine
    if (visibility === 'private' && image.assignedToWine && image.wineDefinition) {
      const imageUrl = image.processedUrl || image.originalUrl;
      const wine = await WineDefinition.findById(image.wineDefinition);
      if (wine && wine.image === imageUrl) {
        wine.image = null;
        wine.imageCredit = null;
        await wine.save();
        searchService.indexWine(image.wineDefinition);
      }
      image.assignedToWine = false;
    }

    image.visibility = visibility;
    await image.save();

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.visibility',
      { type: 'image', id: image._id },
      { visibility }
    );

    res.json({ image });
  } catch (error) {
    console.error('Change visibility error:', error);
    res.status(500).json({ error: 'Failed to change image visibility' });
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
