const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const WineRequest = require('../models/WineRequest');
const WineDefinition = require('../models/WineDefinition');
const { findVisibleWine } = require('../services/wineVisibility');
const { createWineRequest } = require('../services/accountOps');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// POST /api/wine-requests - Submit wine request (new_wine or grape_suggestion)
// requireNonDemo: wine requests land in the admin review queue and persist after
// the demo is reaped — queue-spam vector.
router.post('/', requireNonDemo, async (req, res) => {
  try {
    const { requestType = 'new_wine', wineName, sourceUrl, image, linkedWineDefinition, suggestedGrapes } = req.body;

    if (requestType === 'grape_suggestion') {
      // ── Grape suggestion for an existing wine ──
      if (!linkedWineDefinition) {
        return res.status(400).json({ error: 'linkedWineDefinition is required for grape suggestions' });
      }
      if (!Array.isArray(suggestedGrapes) || suggestedGrapes.length === 0) {
        return res.status(400).json({ error: 'At least one grape variety is required' });
      }
      // Ensure linkedWineDefinition is a valid literal id, not a query object
      if (typeof linkedWineDefinition !== 'string' || !/^[0-9a-fA-F]{24}$/.test(linkedWineDefinition)) {
        return res.status(400).json({ error: 'Invalid linkedWineDefinition id' });
      }
      // Visible-to-this-user, not merely existing (services/wineVisibility) —
      // otherwise a grape suggestion is a probe that confirms a stranger's
      // pending row exists, and copies its name into the admin queue.
      const wine = await findVisibleWine(linkedWineDefinition, {
        userId: req.user.id, roles: req.user.roles,
      });
      if (!wine) return res.status(404).json({ error: 'Wine not found' });

      const wineRequest = new WineRequest({
        requestType: 'grape_suggestion',
        wineName: wine.name,
        linkedWineDefinition: wine._id,
        suggestedGrapes: suggestedGrapes.map(g => String(g).trim()).filter(Boolean).slice(0, 20),
        user: req.user.id,
        status: 'pending'
      });
      await wineRequest.save();
      logAudit(req, 'wineRequest.create', { type: 'wineRequest', id: wineRequest._id });
      return res.status(201).json({ wineRequest });
    }

    // ── New wine request ── (validation + creation shared with the MCP
    // request_wine_addition tool via services/accountOps)
    const { wineRequest, error } = await createWineRequest(req.user.id, { wineName, sourceUrl, image });
    if (error) return res.status(error.status).json({ error: error.message });
    logAudit(req, 'wineRequest.create', { type: 'wineRequest', id: wineRequest._id });
    res.status(201).json({ wineRequest });
  } catch (error) {
    console.error('Create wine request error:', error);
    res.status(500).json({ error: 'Failed to create wine request' });
  }
});

// GET /api/wine-requests - List current user's wine requests
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { user: req.user.id };

    // Must match the WineRequest schema enum — resolve sets 'resolved', not 'approved'.
    // 'withdrawn' (request left the queue with its deleted cellar) stays
    // visible in the user's OWN list — it is their history — and filterable.
    const validStatuses = ['pending', 'resolved', 'rejected', 'withdrawn'];
    if (status) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}` });
      }
      filter.status = status;
    }

    const requests = await WineRequest.find(filter)
      .populate('linkedWineDefinition')
      .populate('resolvedBy', 'username')
      .sort({ createdAt: -1 });

    res.json({
      count: requests.length,
      requests
    });
  } catch (error) {
    console.error('Get wine requests error:', error);
    res.status(500).json({ error: 'Failed to get wine requests' });
  }
});

module.exports = router;
