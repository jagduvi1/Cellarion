const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { requireAuth, requireFeature } = require('../middleware/auth');
const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { logAudit } = require('../services/audit');
const { generateWineListPdf } = require('../services/wineListPdf');
const { planHasFeature } = require('../config/plans');

const router = express.Router();

// --- Logo upload setup ---
const LOGO_DIR = '/app/uploads/wine-list-logos';
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGO_DIR),
  filename: (req, file, cb) => {
    const uuid = crypto.randomUUID();
    const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    const ext = mimeToExt[file.mimetype] || '.jpg';
    cb(null, `${uuid}${ext}`);
  }
});
const logoUpload = multer({
  storage: logoStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPEG, PNG, and WebP images are allowed'), allowed.includes(file.mimetype));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// --- Helpers ---

/** Verify user owns the cellar (or is a member with editor+ role). */
async function requireCellarOwner(userId, cellarId) {
  const cellar = await Cellar.findOne({ _id: cellarId, user: userId, deletedAt: null });
  return cellar;
}

/** Load and populate bottles for a wine list, returning a Map<bottleId, bottle>. */
async function loadBottleMap(wineList) {
  // Collect all bottle IDs from both modes
  const bottleIds = new Set();
  if (wineList.structureMode === 'custom') {
    for (const section of wineList.sections || []) {
      for (const entry of section.entries || []) {
        bottleIds.add(entry.bottle.toString());
      }
    }
  } else {
    for (const entry of wineList.autoGroupEntries || []) {
      bottleIds.add(entry.bottle.toString());
    }
  }

  const bottles = await Bottle.find({ _id: { $in: [...bottleIds] } })
    .populate({
      path: 'wineDefinition',
      populate: [
        { path: 'country', select: 'name' },
        { path: 'region', select: 'name' },
        { path: 'grapes', select: 'name' },
      ],
      select: 'name producer type appellation country region grapes classification'
    })
    .lean();

  const map = new Map();
  for (const b of bottles) {
    map.set(b._id.toString(), b);
  }
  return map;
}

// =====================================================================
// Authenticated routes — requireAuth + requireFeature('wineLists')
// =====================================================================

// GET /api/wine-lists?cellar=:cellarId — list wine lists for a cellar
router.get('/', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const { cellar: cellarId } = req.query;
    if (!cellarId) return res.status(400).json({ error: 'cellar query parameter is required' });

    // Verify ownership
    const cellar = await requireCellarOwner(req.user.id, cellarId);
    if (!cellar) return res.status(403).json({ error: 'Not authorized' });

    const lists = await WineList.find({ cellar: cellarId, user: req.user.id })
      .select('name structureMode isPublished shareToken createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    res.json(lists);
  } catch (error) {
    console.error('List wine lists error:', error);
    res.status(500).json({ error: 'Failed to load wine lists' });
  }
});

// POST /api/wine-lists — create a new wine list
router.post('/', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const { cellar: cellarId, name } = req.body;
    if (!cellarId || !name) return res.status(400).json({ error: 'cellar and name are required' });

    const cellar = await requireCellarOwner(req.user.id, cellarId);
    if (!cellar) return res.status(403).json({ error: 'Not authorized' });

    const wineList = new WineList({
      cellar: cellarId,
      user: req.user.id,
      name,
      structureMode: req.body.structureMode || 'auto',
    });

    await wineList.save();
    logAudit(req, 'winelist.create', { type: 'winelist', id: wineList._id, cellarId }, { name });

    res.status(201).json(wineList);
  } catch (error) {
    console.error('Create wine list error:', error);
    res.status(500).json({ error: 'Failed to create wine list' });
  }
});

// GET /api/wine-lists/:id — get wine list details
router.get('/:id', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    res.json(wineList);
  } catch (error) {
    console.error('Get wine list error:', error);
    res.status(500).json({ error: 'Failed to load wine list' });
  }
});

// PUT /api/wine-lists/:id — update wine list
router.put('/:id', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    // Allowed update fields
    const fields = [
      'name', 'structureMode',
      'sections', 'autoGrouping', 'autoGroupEntries',
      'branding', 'layout',
    ];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        wineList[field] = req.body[field];
      }
    }

    await wineList.save();
    logAudit(req, 'winelist.update', { type: 'winelist', id: wineList._id, cellarId: wineList.cellar });

    res.json(wineList);
  } catch (error) {
    if (error.name === 'VersionError') {
      return res.status(409).json({ error: 'Wine list was modified by another request. Please refresh and try again.' });
    }
    console.error('Update wine list error:', error);
    res.status(500).json({ error: 'Failed to update wine list' });
  }
});

// DELETE /api/wine-lists/:id
router.delete('/:id', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const wineList = await WineList.findOneAndDelete({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    logAudit(req, 'winelist.delete', { type: 'winelist', id: wineList._id, cellarId: wineList.cellar });

    res.json({ message: 'Wine list deleted' });
  } catch (error) {
    console.error('Delete wine list error:', error);
    res.status(500).json({ error: 'Failed to delete wine list' });
  }
});

// POST /api/wine-lists/:id/publish — generate token and publish
router.post('/:id/publish', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    if (!wineList.shareToken) {
      wineList.shareToken = crypto.randomBytes(32).toString('hex');
      wineList.shareTokenCreatedAt = new Date();
    }
    wineList.isPublished = true;
    await wineList.save();

    logAudit(req, 'winelist.publish', { type: 'winelist', id: wineList._id, cellarId: wineList.cellar });

    res.json({ shareToken: wineList.shareToken, isPublished: true });
  } catch (error) {
    console.error('Publish wine list error:', error);
    res.status(500).json({ error: 'Failed to publish wine list' });
  }
});

// POST /api/wine-lists/:id/unpublish — disable public URL
router.post('/:id/unpublish', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    wineList.isPublished = false;
    await wineList.save();

    logAudit(req, 'winelist.unpublish', { type: 'winelist', id: wineList._id, cellarId: wineList.cellar });

    res.json({ isPublished: false });
  } catch (error) {
    console.error('Unpublish wine list error:', error);
    res.status(500).json({ error: 'Failed to unpublish wine list' });
  }
});

// GET /api/wine-lists/:id/preview-pdf — generate PDF preview (authenticated)
router.get('/:id/preview-pdf', requireAuth, requireFeature('wineLists'), async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    const bottleMap = await loadBottleMap(wineList);
    const pdfStream = generateWineListPdf(wineList, bottleMap);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(wineList.name || 'wine-list')}.pdf"`);
    pdfStream.pipe(res);
  } catch (error) {
    console.error('Preview PDF error:', error);
    res.status(500).json({ error: 'Failed to generate PDF preview' });
  }
});

// POST /api/wine-lists/:id/logo — upload restaurant logo
router.post('/:id/logo', requireAuth, requireFeature('wineLists'), logoUpload.single('logo'), async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });
    if (!req.file) return res.status(400).json({ error: 'No logo file provided' });

    wineList.branding = wineList.branding || {};
    wineList.branding.logoUrl = `wine-list-logos/${req.file.filename}`;
    await wineList.save();

    res.json({ logoUrl: wineList.branding.logoUrl });
  } catch (error) {
    console.error('Upload logo error:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

module.exports = router;
