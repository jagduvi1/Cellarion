const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const WineRequest = require('../models/WineRequest');
const WineDefinition = require('../models/WineDefinition');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Validate a URL string — returns error message or null if valid
function validateUrl(url) {
  if (!url || typeof url !== 'string') return 'Source URL is required';
  if (url.length > 2048) return 'URL is too long (max 2048 characters)';
  let parsed;
  try { parsed = new URL(url); } catch { return 'Please provide a valid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'URL must use http or https protocol';
  const h = parsed.hostname.toLowerCase();
  const private_ = [
    /^localhost$/, /^127\.\d+\.\d+\.\d+$/, /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, /^192\.168\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/, /^0\.0\.0\.0$/, /^\[?::1?\]?$/
  ];
  if (private_.some(p => p.test(h))) return 'URLs pointing to private/internal addresses are not allowed';
  return null;
}

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
      const wine = await WineDefinition.findById(linkedWineDefinition);
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

    // ── New wine request ──
    if (!wineName) return res.status(400).json({ error: 'Wine name and source URL are required' });
    const urlErr = validateUrl(sourceUrl);
    if (urlErr) return res.status(400).json({ error: urlErr });

    // Bound the free-text/image fields so a single request can't persist a
    // multi-MB string (the route's body limit is 5mb) and bloat the admin queue.
    const trimmedName = wineName.trim();
    const trimmedImage = image ? String(image).trim() : '';
    if (trimmedName.length > 300) {
      return res.status(400).json({ error: 'Wine name must be 300 characters or fewer' });
    }
    if (trimmedImage.length > 500000) {
      return res.status(400).json({ error: 'Image reference is too large' });
    }

    const wineRequest = new WineRequest({
      requestType: 'new_wine',
      wineName: trimmedName,
      sourceUrl: sourceUrl.trim(),
      image: trimmedImage || null,
      user: req.user.id,
      status: 'pending'
    });
    await wineRequest.save();
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

    // Must match the WineRequest schema enum — resolve sets 'resolved', not 'approved'
    const validStatuses = ['pending', 'resolved', 'rejected'];
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
