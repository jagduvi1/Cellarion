const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { logAudit } = require('../services/audit');
const { generateWineListPdf } = require('../services/wineListPdf');

const router = express.Router();

// --- Logo upload setup ---
const LOGO_DIR = '/app/uploads/wine-list-logos';
// Ensure logo directory exists on startup
try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch { /* Docker volume may already exist */ }
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
  if (!mongoose.Types.ObjectId.isValid(cellarId)) return null;
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
// Authenticated routes
// =====================================================================

// GET /api/wine-lists?cellar=:cellarId — list wine lists for a cellar
router.get('/', requireAuth, async (req, res) => {
  try {
    const { cellar: cellarId } = req.query;
    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellar ID is required' });
    }

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
router.post('/', requireAuth, async (req, res) => {
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
router.get('/:id', requireAuth, async (req, res) => {
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
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    // Allowed update fields
    const fields = [
      'name', 'structureMode', 'language',
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
router.delete('/:id', requireAuth, async (req, res) => {
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
router.post('/:id/publish', requireAuth, async (req, res) => {
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
router.post('/:id/unpublish', requireAuth, async (req, res) => {
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
router.get('/:id/preview-pdf', requireAuth, async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    const bottleMap = await loadBottleMap(wineList);

    // Build public URL for QR code if published
    let publicUrl = null;
    if (wineList.isPublished && wineList.shareToken) {
      const base = process.env.FRONTEND_URL || 'http://localhost:5000';
      publicUrl = `${base}/api/wine-lists/public/${wineList.shareToken}/pdf`;
    }

    const pdfStream = await generateWineListPdf(wineList, bottleMap, { publicUrl });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(wineList.name || 'wine-list')}.pdf"`);
    pdfStream.pipe(res);
  } catch (error) {
    console.error('Preview PDF error:', error);
    res.status(500).json({ error: 'Failed to generate PDF preview' });
  }
});

// POST /api/wine-lists/:id/logo — upload restaurant logo
router.post('/:id/logo', requireAuth, logoUpload.single('logo'), async (req, res) => {
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

// GET /api/wine-lists/:id/stats — stock count + profit margin per entry
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    const bottleMap = await loadBottleMap(wineList);

    // Collect all entries from both modes
    const entries = wineList.structureMode === 'custom'
      ? (wineList.sections || []).flatMap(s => s.entries || [])
      : (wineList.autoGroupEntries || []);

    // Count stock per wineDefinition in this cellar
    const activeBottles = await Bottle.find({
      cellar: wineList.cellar,
      status: 'active',
    }).select('wineDefinition price').lean();

    // Build stock counts: wineDefinitionId → { count, avgPurchasePrice }
    const stockMap = new Map();
    for (const b of activeBottles) {
      const wdId = b.wineDefinition?.toString();
      if (!wdId) continue;
      if (!stockMap.has(wdId)) stockMap.set(wdId, { count: 0, totalCost: 0, pricedCount: 0 });
      const s = stockMap.get(wdId);
      s.count++;
      if (b.price != null) {
        s.totalCost += b.price;
        s.pricedCount++;
      }
    }

    // Build stats per wine list entry
    const stats = [];
    let totalRevenue = 0;
    let totalCost = 0;

    for (const entry of entries) {
      const bottle = bottleMap.get(entry.bottle.toString());
      if (!bottle || bottle.status !== 'active') continue;

      const wine = bottle.wineDefinition || {};
      const wdId = wine._id?.toString();
      const stock = wdId ? stockMap.get(wdId) : null;
      const stockCount = stock?.count || 0;
      const avgCost = stock?.pricedCount > 0 ? stock.totalCost / stock.pricedCount : null;
      const listPrice = entry.listPrice != null ? entry.listPrice : bottle.price;
      const margin = (avgCost != null && listPrice != null && avgCost > 0)
        ? Math.round(((listPrice - avgCost) / avgCost) * 100)
        : null;

      if (listPrice != null) totalRevenue += listPrice * stockCount;
      if (avgCost != null) totalCost += avgCost * stockCount;

      stats.push({
        bottleId: bottle._id,
        wineName: wine.name || 'Unknown',
        producer: wine.producer || '',
        vintage: bottle.vintage || 'NV',
        stockCount,
        purchasePrice: avgCost != null ? Math.round(avgCost) : null,
        listPrice: listPrice != null ? Math.round(listPrice) : null,
        marginPercent: margin,
      });
    }

    const totalMargin = totalCost > 0 ? Math.round(((totalRevenue - totalCost) / totalCost) * 100) : null;

    res.json({
      entries: stats,
      summary: {
        totalWines: stats.length,
        totalBottlesInStock: stats.reduce((sum, s) => sum + s.stockCount, 0),
        potentialRevenue: Math.round(totalRevenue),
        totalCost: Math.round(totalCost),
        overallMarginPercent: totalMargin,
      },
    });
  } catch (error) {
    console.error('Wine list stats error:', error);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
