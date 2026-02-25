const express = require('express');
const { requireAuth } = require('../middleware/auth');
const WineRequest = require('../models/WineRequest');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// POST /api/wine-requests - Submit wine request
router.post('/', async (req, res) => {
  try {
    const { wineName, sourceUrl, image } = req.body;

    if (!wineName || !sourceUrl) {
      return res.status(400).json({ error: 'Wine name and source URL are required' });
    }

    // Validate URL format
    const urlPattern = /^https?:\/\/.+/;
    if (!urlPattern.test(sourceUrl)) {
      return res.status(400).json({ error: 'Please provide a valid URL (must start with http:// or https://)' });
    }

    const wineRequest = new WineRequest({
      wineName: wineName.trim(),
      sourceUrl: sourceUrl.trim(),
      image: image?.trim() || null,
      user: req.user.id,
      status: 'pending'
    });

    await wineRequest.save();
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

    if (status) {
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

// GET /api/wine-requests/:id - Get single wine request
router.get('/:id', async (req, res) => {
  try {
    const wineRequest = await WineRequest.findOne({
      _id: req.params.id,
      user: req.user.id
    })
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

module.exports = router;
