const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { logAudit } = require('../services/audit');
const { isValidId } = require('../utils/validation');
const { generateWineListPdf } = require('../services/wineListPdf');
const { stripImageMetadata } = require('../services/imageSanitizer');
const { loadBottleMap } = require('../services/wineListData');

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

/** Verify user owns the cellar. Wine lists are owner-only (the cellar-detail
 *  link is gated the same way) — shared members cannot manage them. */
async function requireCellarOwner(userId, cellarId) {
  if (!mongoose.Types.ObjectId.isValid(cellarId)) return null;
  const cellar = await Cellar.findOne({ _id: cellarId, user: userId, deletedAt: null });
  return cellar;
}

/** Delete a stored logo file, ignoring missing files. */
function deleteLogoFile(logoUrl) {
  if (!logoUrl) return;
  const filename = path.basename(logoUrl);
  try { fs.unlinkSync(path.join(LOGO_DIR, filename)); } catch { /* already gone */ }
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    // Allowed update fields
    const fields = [
      'name', 'structureMode', 'language',
      'sections', 'autoGrouping', 'autoGroupEntries',
      'branding', 'layout',
    ];
    // logoUrl is server-generated by the logo upload endpoint only — a
    // client-supplied value would flow into path.join() during PDF rendering
    // (path traversal). Always preserve the stored value.
    const storedLogoUrl = wineList.branding?.logoUrl;
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        wineList[field] = req.body[field];
      }
    }
    if (req.body.branding !== undefined) {
      wineList.branding.logoUrl = storedLogoUrl;
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wineList = await WineList.findOneAndDelete({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    deleteLogoFile(wineList.branding?.logoUrl);
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });
    if (!req.file) return res.status(400).json({ error: 'No logo file provided' });

    // Re-encode in place to strip EXIF/GPS metadata — logos shot on a phone
    // embed location, and the file ends up in shared/public PDFs.
    try {
      await stripImageMetadata(req.file.path);
    } catch (err) {
      console.error('Logo sanitization failed:', err.message);
      try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
      return res.status(400).json({ error: 'Logo could not be processed — the file may be corrupt or too large' });
    }

    const previousLogoUrl = wineList.branding?.logoUrl;
    wineList.branding = wineList.branding || {};
    wineList.branding.logoUrl = `wine-list-logos/${req.file.filename}`;
    await wineList.save();

    // Remove the previous logo (after a successful save) so replaced uploads
    // don't pile up on disk
    if (previousLogoUrl && previousLogoUrl !== wineList.branding.logoUrl) {
      deleteLogoFile(previousLogoUrl);
    }

    res.json({ logoUrl: wineList.branding.logoUrl });
  } catch (error) {
    console.error('Upload logo error:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// GET /api/wine-lists/:id/stats — stock count + profit margin per entry
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
