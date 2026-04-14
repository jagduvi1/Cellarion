const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const WineRequest = require('../../models/WineRequest');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const { generateWineKey } = require('../../utils/normalize');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { createNotification } = require('../../services/notifications');
const { stripHtml } = require('../../utils/sanitize');
const { incrementCred } = require('../../utils/cellarCred');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wine-requests - List all wine requests
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const { limit, offset: skip } = parsePagination(req.query, { limit: 50, maxLimit: 200 });
    const filter = {};
    const VALID_STATUSES = ['pending', 'resolved', 'rejected'];

    if (status) {
      if (!VALID_STATUSES.includes(String(status))) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      filter.status = String(status);
    }

    const [requests, total] = await Promise.all([
      WineRequest.find(filter)
        .populate('user', 'username email')
        .populate({
          path: 'linkedWineDefinition',
          populate: ['country', 'region', 'grapes']
        })
        .populate('resolvedBy', 'username')
        .sort({ status: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit),
      WineRequest.countDocuments(filter)
    ]);

    res.json({
      count: requests.length,
      total,
      requests
    });
  } catch (error) {
    console.error('Get wine requests error:', error);
    res.status(500).json({ error: 'Failed to get wine requests' });
  }
});

// GET /api/admin/wine-requests/:id - Get single wine request
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wineRequest = await WineRequest.findById(req.params.id)
      .populate('user', 'username email')
      .populate({
        path: 'linkedWineDefinition',
        populate: ['country', 'region', 'grapes']
      })
      .populate('resolvedBy', 'username');

    if (!wineRequest) {
      return res.status(404).json({ error: 'Wine request not found' });
    }

    res.json({ wineRequest });
  } catch (error) {
    console.error('Get wine request error:', error);
    res.status(500).json({ error: 'Failed to get wine request' });
  }
});

// PUT /api/admin/wine-requests/:id/resolve - Resolve wine request
router.put('/:id/resolve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { wineDefinitionId, createNew, wineData, adminNotes, applyGrapes } = req.body;

    const wineRequest = await WineRequest.findById(req.params.id);
    if (!wineRequest) {
      return res.status(404).json({ error: 'Wine request not found' });
    }

    if (wineRequest.status !== 'pending') {
      return res.status(400).json({ error: 'Wine request has already been resolved' });
    }

    let linkedWine;

    // ── Grape suggestion: apply selected grapes to the linked wine ──
    if (wineRequest.requestType === 'grape_suggestion') {
      if (!wineRequest.linkedWineDefinition) {
        return res.status(400).json({ error: 'Grape suggestion has no linked wine definition' });
      }
      linkedWine = await WineDefinition.findById(wineRequest.linkedWineDefinition);
      if (!linkedWine) {
        return res.status(404).json({ error: 'Linked wine definition not found' });
      }
      if (Array.isArray(applyGrapes) && applyGrapes.length > 0) {
        const existing = new Set(linkedWine.grapes.map(g => g.toString()));
        for (const grapeId of applyGrapes) {
          if (!existing.has(grapeId.toString())) {
            linkedWine.grapes.push(grapeId);
          }
        }
        await linkedWine.save();
        searchService.indexWine(linkedWine._id);
      }
    } else if (createNew && wineData) {
      // Create new wine definition
      const { name, producer, country, region, appellation, grapes, type, image } = wineData;

      if (!name || !producer || !country) {
        return res.status(400).json({ error: 'Name, producer, and country are required to create wine' });
      }

      const normalizedKey = generateWineKey(name, producer, appellation);

      linkedWine = new WineDefinition({
        name: name.trim(),
        producer: producer.trim(),
        country,
        region: region || null,
        appellation: appellation?.trim(),
        grapes: grapes || [],
        type: type || 'red',
        image: image || wineRequest.image || null,
        normalizedKey,
        createdBy: req.user.id
      });

      await linkedWine.save();

      // Sync to search index (fire-and-forget)
      searchService.indexWine(linkedWine._id);
    } else if (wineDefinitionId) {
      // Link to existing wine
      linkedWine = await WineDefinition.findById(wineDefinitionId);
      if (!linkedWine) {
        return res.status(404).json({ error: 'Wine definition not found' });
      }
    } else {
      return res.status(400).json({ error: 'Must provide either wineDefinitionId or wineData to create new wine' });
    }

    // Update wine request
    wineRequest.status = 'resolved';
    wineRequest.resolvedBy = req.user.id;
    wineRequest.resolvedAt = new Date();
    wineRequest.linkedWineDefinition = linkedWine._id;
    wineRequest.adminNotes = adminNotes ? stripHtml(adminNotes) : '';

    await wineRequest.save();

    // Award Cellar Cred to the submitting user
    const credEvent = wineRequest.requestType === 'grape_suggestion' ? 'grape_suggestion_approved' : 'wine_request_approved';
    incrementCred(wineRequest.user, credEvent).catch(() => {});

    // Backfill any bottles that were imported while waiting for this wine
    let backfilledCount = 0;
    if (wineRequest.requestType === 'new_wine') {
      const result = await Bottle.updateMany(
        { pendingWineRequest: wineRequest._id },
        { $set: { wineDefinition: linkedWine._id }, $unset: { pendingWineRequest: '' } }
      );
      backfilledCount = result.modifiedCount || 0;
    }

    let notifMsg;
    if (wineRequest.requestType === 'grape_suggestion') {
      notifMsg = `Your grape suggestion for "${wineRequest.wineName}" has been reviewed. Thank you for helping improve the wine registry!`;
    } else if (backfilledCount > 0) {
      notifMsg = `Your request for "${wineRequest.wineName}" has been approved and added to the registry as "${linkedWine.name}" by ${linkedWine.producer}. Your ${backfilledCount} bottle${backfilledCount !== 1 ? 's' : ''} in the cellar have been updated.`;
    } else {
      notifMsg = `Your request for "${wineRequest.wineName}" has been approved. It was added to the registry as "${linkedWine.name}" by ${linkedWine.producer}.`;
    }

    createNotification(
      wineRequest.user,
      'wine_request_resolved',
      'Wine request approved',
      notifMsg,
      '/wine-requests'
    );

    await wineRequest.populate([
      { path: 'user', select: 'username email' },
      {
        path: 'linkedWineDefinition',
        populate: ['country', 'region', 'grapes']
      },
      { path: 'resolvedBy', select: 'username' }
    ]);

    logAudit(req, 'admin.request.resolve',
      { type: 'wineRequest', id: wineRequest._id },
      { wineName: wineRequest.wineName, linkedWineId: linkedWine._id }
    );

    res.json({ wineRequest });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        error: 'Wine already exists with this name, producer, and appellation combination'
      });
    }
    console.error('Resolve wine request error:', error);
    res.status(500).json({ error: 'Failed to resolve wine request' });
  }
});

// PUT /api/admin/wine-requests/:id/reject - Reject wine request
router.put('/:id/reject', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { adminNotes } = req.body;

    if (!adminNotes || !adminNotes.trim()) {
      return res.status(400).json({ error: 'Admin notes are required when rejecting a request' });
    }

    const wineRequest = await WineRequest.findById(req.params.id);
    if (!wineRequest) {
      return res.status(404).json({ error: 'Wine request not found' });
    }

    if (wineRequest.status !== 'pending') {
      return res.status(400).json({ error: 'Wine request has already been resolved' });
    }

    wineRequest.status = 'rejected';
    wineRequest.resolvedBy = req.user.id;
    wineRequest.resolvedAt = new Date();
    wineRequest.adminNotes = adminNotes.trim();

    await wineRequest.save();

    createNotification(
      wineRequest.user,
      'wine_request_rejected',
      'Wine request declined',
      `Your request for "${wineRequest.wineName}" was declined. Reason: ${adminNotes.trim()}`,
      '/wine-requests'
    );

    await wineRequest.populate([
      { path: 'user', select: 'username email' },
      { path: 'resolvedBy', select: 'username' }
    ]);

    logAudit(req, 'admin.request.reject',
      { type: 'wineRequest', id: wineRequest._id },
      { wineName: wineRequest.wineName }
    );

    res.json({ wineRequest });
  } catch (error) {
    console.error('Reject wine request error:', error);
    res.status(500).json({ error: 'Failed to reject wine request' });
  }
});

module.exports = router;
