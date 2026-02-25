const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const WineRequest = require('../../models/WineRequest');
const WineDefinition = require('../../models/WineDefinition');
const { generateWineKey } = require('../../utils/normalize');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wine-requests - List all wine requests
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};

    if (status) {
      filter.status = status;
    }

    const requests = await WineRequest.find(filter)
      .populate('user', 'username email')
      .populate({
        path: 'linkedWineDefinition',
        populate: ['country', 'region', 'grapes']
      })
      .populate('resolvedBy', 'username')
      .sort({ status: 1, createdAt: 1 }); // Pending first, oldest first

    res.json({
      count: requests.length,
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
    const { wineDefinitionId, createNew, wineData, adminNotes } = req.body;

    const wineRequest = await WineRequest.findById(req.params.id);
    if (!wineRequest) {
      return res.status(404).json({ error: 'Wine request not found' });
    }

    if (wineRequest.status !== 'pending') {
      return res.status(400).json({ error: 'Wine request has already been resolved' });
    }

    let linkedWine;

    if (createNew && wineData) {
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
    wineRequest.adminNotes = adminNotes?.trim() || '';

    await wineRequest.save();
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
