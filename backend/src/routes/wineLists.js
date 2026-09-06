const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
// Audit 2026-09 S2-3: the write routes are demo-blocked like their MCP twins —
// an anonymous demo session must not publish a public, branded wine list or
// consume disk with logos and duplicates. Reads stay open for the demo tour.
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const { logAudit } = require('../services/audit');
const { isValidId } = require('../utils/validation');
const { generateWineListPdf } = require('../services/wineListPdf');
const { stripImageMetadata } = require('../services/imageSanitizer');
const { loadWineMap, loadCellarWines, entryKey, allEntries } = require('../services/wineListData');
const { LOGO_DIR, ensureLogoDir, deleteLogoFile, copyLogoFile } = require('../services/wineListLogos');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');

const router = express.Router();

/** Every distinct wine id referenced by a list, in any structure mode. */
const entryWineIds = (wineList) =>
  new Set(allEntries(wineList).filter(e => e.wine).map(e => String(e.wine)));

/**
 * Refuse to ADD a pendingIdentity wine to a wine list.
 *
 * ABSOLUTE, like the discussion gate and for the same reason: a list can be
 * PUBLISHED, and routes/wineListPublic.js serves it with no auth — so attaching
 * is the act that would make a hidden half-identified wine public. Enforced at
 * WRITE time, which closes the public render, the PDF and the stats endpoint in
 * one place.
 *
 * Only NEWLY referenced wines are checked. The PUT replaces sections wholesale,
 * so judging the whole payload would soft-lock any list that already carried a
 * pending row from before this gate existed — the owner could not even edit it
 * to remove the entry. Rows already on the list are handled by the read-side
 * exclusion in services/wineListData.loadWineMap, which drops them from every
 * render; this gate stops the set from growing.
 *
 * @returns {Promise<string|null>} an error message, or null when the write is clean
 */
async function pendingWineAdded(wineList, previousIds) {
  const added = [...entryWineIds(wineList)].filter(id => !previousIds.has(id));
  if (!added.length) return null;
  const pending = await WineDefinition.find({ _id: { $in: added }, pendingIdentity: true })
    .select('name').limit(3).lean();
  if (!pending.length) return null;
  return `This wine is still waiting for its producer to be identified and can't go on a list that may be published: ${pending.map(w => w.name).join(', ')}`;
}

// --- Logo upload setup ---
ensureLogoDir();
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

// GET /api/wine-lists/cellar-wines?cellar=:cellarId — distinct wines in the
// cellar (active bottles grouped by wine + vintage + size, with stock and
// average purchase price) for the editor's picker
router.get('/cellar-wines', requireAuth, async (req, res) => {
  try {
    const { cellar: cellarId } = req.query;
    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellar ID is required' });
    }

    const cellar = await requireCellarOwner(req.user.id, cellarId);
    if (!cellar) return res.status(403).json({ error: 'Not authorized' });

    const wines = await loadCellarWines(cellarId);
    res.json(wines);
  } catch (error) {
    console.error('Cellar wines error:', error);
    res.status(500).json({ error: 'Failed to load cellar wines' });
  }
});

// POST /api/wine-lists — create a new wine list
router.post('/', requireAuth, requireNonDemo, async (req, res) => {
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

    // Inherit the user's currency so a Swedish list doesn't start life in $
    if (typeof req.body.currency === 'string' && req.body.currency.trim()) {
      wineList.layout.currency = req.body.currency.trim().slice(0, 10);
    }
    if (typeof req.body.currencySymbol === 'string' && req.body.currencySymbol.trim()) {
      wineList.layout.currencySymbol = req.body.currencySymbol.trim().slice(0, 5);
    }

    await wineList.save();
    logAudit(req, 'winelist.create', { type: 'winelist', id: wineList._id, cellarId }, { name });

    res.status(201).json(wineList);
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Create wine list error:', error);
    res.status(500).json({ error: 'Failed to create wine list' });
  }
});

// GET /api/wine-lists/:id — get wine list details.
// resolvedWines carries the populated wine + live stock for every entry, so
// the editor can label entries whose wine has no active bottles left (those
// are absent from the cellar-wines picker data).
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    const wineMap = await loadWineMap(wineList);
    const resolvedWines = [...wineMap.entries()].map(([key, v]) => {
      const [, vintage, bottleSize] = key.split('|');
      return { key, wine: v.wine, vintage, bottleSize, stock: v.stock, avgPrice: v.avgPrice };
    });

    res.json({ ...wineList.toObject(), resolvedWines });
  } catch (error) {
    console.error('Get wine list error:', error);
    res.status(500).json({ error: 'Failed to load wine list' });
  }
});

// PUT /api/wine-lists/:id — update wine list
router.put('/:id', requireAuth, requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    // Snapshot the wines already on the list BEFORE the payload overwrites
    // sections — pendingWineAdded only judges what this write introduces.
    const previousWineIds = entryWineIds(wineList);

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
      // Guard against `branding: null` — the restore below must never throw
      if (!wineList.branding) wineList.branding = {};
      wineList.branding.logoUrl = storedLogoUrl;
    }

    const pendingMsg = await pendingWineAdded(wineList, previousWineIds);
    if (pendingMsg) return res.status(400).json({ error: pendingMsg });

    await wineList.save();
    logAudit(req, 'winelist.update', { type: 'winelist', id: wineList._id, cellarId: wineList.cellar });

    res.json(wineList);
  } catch (error) {
    if (error.name === 'VersionError') {
      return res.status(409).json({ error: 'Wine list was modified by another request. Please refresh and try again.' });
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid wine list data' });
    }
    console.error('Update wine list error:', error);
    res.status(500).json({ error: 'Failed to update wine list' });
  }
});

// POST /api/wine-lists/:id/add-bottles — put the wines of MANY bottles on a
// list in one step (the cellar view's select mode, support ticket 6a9949e3).
// Entries are wine + vintage + size, so a case of twelve becomes ONE line, and
// a wine already on the list is reported as skipped, never duplicated. Same
// rules as the MCP add_to_list tool: writes go to the ACTIVE container only, a
// custom-structured list needs a section (created if new) unless it has
// exactly one, and a pendingIdentity wine is refused — the list may be
// published. Bottles must be in cellars the caller OWNS (lists are owner-only).
// Prices are left for the editor: a menu price is a decision, not a purchase
// price.
// Body:     { bottleIds: string[] (≤500), section?: string }
// Response: { added, skipped: [{ id, reason }], list: { _id, name } }
//   reason ∈ 'not_found', 'no_wine', 'pending_wine', 'already_on_list'
router.post('/:id/add-bottles', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { bottleIds, section } = req.body || {};
    if (!Array.isArray(bottleIds) || bottleIds.length === 0) {
      return res.status(400).json({ error: 'bottleIds must be a non-empty array' });
    }
    if (bottleIds.length > 500) return res.status(400).json({ error: 'At most 500 bottles per request' });
    if (!bottleIds.every((x) => typeof x === 'string' && mongoose.Types.ObjectId.isValid(x))) {
      return res.status(400).json({ error: 'bottleIds must be valid bottle ids' });
    }

    const wineList = await WineList.findOne({ _id: req.params.id, user: req.user.id });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found' });

    // Target container, resolved exactly as the MCP tool does.
    let container;
    if (wineList.structureMode === 'custom') {
      const wanted = typeof section === 'string' ? section.trim().slice(0, 200) : '';
      if (!wanted) {
        if (wineList.sections.length !== 1) {
          return res.status(400).json({ error: 'This list uses custom sections — choose a section' });
        }
        container = wineList.sections[0].entries;
      } else {
        let sec = wineList.sections.find((s) => s.title.toLowerCase() === wanted.toLowerCase());
        if (!sec) {
          wineList.sections.push({ title: wanted, sortOrder: wineList.sections.length, entries: [] });
          sec = wineList.sections[wineList.sections.length - 1];
        }
        container = sec.entries;
      }
    } else {
      container = wineList.autoGroupEntries;
    }

    const ids = [...new Set(bottleIds.map(String))];
    const bottles = await Bottle.find({ _id: { $in: ids } }).select('cellar wineDefinition vintage bottleSize').lean();
    const byId = new Map(bottles.map((b) => [String(b._id), b]));
    const ownedCellars = new Map();
    const ownsCellar = async (cellarId) => {
      const key = String(cellarId);
      if (!ownedCellars.has(key)) ownedCellars.set(key, !!(await requireCellarOwner(req.user.id, key)));
      return ownedCellars.get(key);
    };
    const wineIds = [...new Set(bottles.map((b) => b.wineDefinition && String(b.wineDefinition)).filter(Boolean))];
    const wines = wineIds.length
      ? await WineDefinition.find({ _id: { $in: wineIds } }).select('pendingIdentity').lean()
      : [];
    const knownWine = new Set(wines.map((w) => String(w._id)));
    const pendingWine = new Set(wines.filter((w) => w.pendingIdentity).map((w) => String(w._id)));

    const keyOf = (wine, vintage, bottleSize) => entryKey({
      wine: String(wine),
      vintage: (vintage || 'NV').trim() || 'NV',
      bottleSize: (bottleSize || '750ml').trim() || '750ml',
    });
    // What is already on the list — EVERY active container, not only the one
    // this request writes to (a custom list's other sections count, as the
    // MCP add_to_list check does) — plus what this request adds.
    const present = new Set(allEntries(wineList).map((e) => keyOf(e.wine, e.vintage, e.bottleSize)));

    let added = 0;
    const skipped = [];
    for (const id of ids) {
      const b = byId.get(id);
      if (!b || !(await ownsCellar(b.cellar))) { skipped.push({ id, reason: 'not_found' }); continue; }
      const wineId = b.wineDefinition ? String(b.wineDefinition) : null;
      if (!wineId || !knownWine.has(wineId)) { skipped.push({ id, reason: 'no_wine' }); continue; }
      if (pendingWine.has(wineId)) { skipped.push({ id, reason: 'pending_wine' }); continue; }
      const key = keyOf(wineId, b.vintage, b.bottleSize);
      if (present.has(key)) { skipped.push({ id, reason: 'already_on_list' }); continue; }
      present.add(key);
      const [, vintage, bottleSize] = key.split('|');
      container.push({ wine: b.wineDefinition, vintage, bottleSize, sortOrder: container.length });
      added++;
    }

    if (added > 0) {
      try {
        await wineList.save();
      } catch (err) {
        if (err.name === 'VersionError') {
          return res.status(409).json({ error: 'Wine list was modified by another request. Please refresh and try again.' });
        }
        if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
        throw err;
      }
      logAudit(req, 'winelist.entry.add',
        { type: 'winelist', id: wineList._id, cellarId: wineList.cellar },
        { added, requested: ids.length, via: 'bulk' });
    }

    res.json({ added, skipped, list: { _id: wineList._id, name: wineList.name } });
  } catch (error) {
    console.error('Add bottles to wine list error:', error);
    res.status(500).json({ error: 'Failed to add the bottles to the wine list' });
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

// POST /api/wine-lists/:id/duplicate — copy a list (e.g. Spring → Summer menu)
router.post('/:id/duplicate', requireAuth, requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const source = await WineList.findOne({ _id: req.params.id, user: req.user.id }).lean();
    if (!source) return res.status(404).json({ error: 'Wine list not found' });

    const { _id, shareToken, shareTokenCreatedAt, createdAt, updatedAt, __v, ...rest } = source;

    // The copy gets its own logo FILE, not just the same URL — otherwise
    // deleting or re-uploading on either list unlinks the other's logo
    if (rest.branding?.logoUrl) {
      rest.branding = { ...rest.branding, logoUrl: copyLogoFile(rest.branding.logoUrl) };
    }

    const copy = new WineList({
      ...rest,
      name: `${source.name} (copy)`.slice(0, 200),
      isPublished: false,
    });
    await copy.save();

    logAudit(req, 'winelist.duplicate', { type: 'winelist', id: copy._id, cellarId: copy.cellar }, { sourceId: source._id });
    res.status(201).json(copy);
  } catch (error) {
    console.error('Duplicate wine list error:', error);
    res.status(500).json({ error: 'Failed to duplicate wine list' });
  }
});

// POST /api/wine-lists/:id/publish — generate token and publish
router.post('/:id/publish', requireAuth, requireNonDemo, async (req, res) => {
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

    const wineMap = await loadWineMap(wineList);

    // Build public URL for QR code if published — points at the web menu.
    // /menu is a frontend route; without FRONTEND_URL fall back to the
    // self-referencing PDF URL (valid on whatever host serves the API).
    let publicUrl = null;
    if (wineList.isPublished && wineList.shareToken) {
      publicUrl = process.env.FRONTEND_URL
        ? `${process.env.FRONTEND_URL}/menu/${wineList.shareToken}`
        : `${req.protocol}://${req.get('host')}/api/wine-lists/public/${wineList.shareToken}/pdf`;
    }

    const pdfStream = await generateWineListPdf(wineList, wineMap, { publicUrl });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(wineList.name || 'wine-list')}.pdf"`);
    pdfStream.pipe(res);
  } catch (error) {
    console.error('Preview PDF error:', error);
    res.status(500).json({ error: 'Failed to generate PDF preview' });
  }
});

// Wrap multer so its errors become 4xx instead of a masked 500 from the
// central handler (same pattern as cellarImport.js / images.js).
function handleLogoUpload(req, res, next) {
  logoUpload.single('logo')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Logo too large (max 5 MB)' });
      return res.status(400).json({ error: err.message || 'Invalid logo upload' });
    }
    next();
  });
}

// POST /api/wine-lists/:id/logo — upload restaurant logo
router.post('/:id/logo', requireAuth, requireNonDemo, handleLogoUpload, async (req, res) => {
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

    const wineMap = await loadWineMap(wineList);

    // Build stats per distinct wine on the list. Out-of-stock wines stay
    // visible with stockCount 0 — that's the restock warning, not a reason
    // to hide the row.
    const stats = [];
    const seen = new Set();
    let totalRevenue = 0;
    let totalCost = 0;

    for (const entry of allEntries(wineList)) {
      const key = entryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);

      const info = wineMap.get(key);
      if (!info) continue; // wine no longer in the registry

      const stockCount = info.stock;
      const avgCost = info.avgPrice;
      const listPrice = entry.listPrice != null ? entry.listPrice : avgCost;
      const margin = (avgCost != null && listPrice != null && avgCost > 0)
        ? Math.round(((listPrice - avgCost) / avgCost) * 100)
        : null;

      if (listPrice != null) totalRevenue += listPrice * stockCount;
      if (avgCost != null) totalCost += avgCost * stockCount;

      stats.push({
        key,
        wineName: info.wine.name || 'Unknown',
        producer: info.wine.producer || '',
        vintage: entry.vintage || 'NV',
        bottleSize: entry.bottleSize || '750ml',
        byGlass: !!entry.byGlass,
        glassPrice: entry.byGlass && entry.glassPrice != null ? Math.round(entry.glassPrice) : null,
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
