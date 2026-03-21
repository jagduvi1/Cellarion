const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireCellarAccess } = require('../middleware/cellarAccess');
const CellarLayout = require('../models/CellarLayout');
const Rack = require('../models/Rack');

const router = express.Router();
router.use(requireAuth);

const MAX_RACK_PLACEMENTS = 100;

// GET /api/cellar-layout?cellar=:id  — get room layout (viewer+)
router.get('/', requireCellarAccess('viewer'), async (req, res) => {
  try {
    const layout = await CellarLayout.findOne({ cellar: req.cellar._id });
    res.json({ layout: layout || { cellar: req.cellar._id, roomDimensions: { width: 10, depth: 10, height: 3 }, rackPlacements: [] } });
  } catch (err) {
    console.error('Get cellar layout error:', err);
    res.status(500).json({ error: 'Failed to get cellar layout' });
  }
});

// PUT /api/cellar-layout  — upsert room layout (editor+)
router.put('/', requireCellarAccess('editor'), async (req, res) => {
  try {
    const { roomDimensions, rackPlacements } = req.body;

    // Validate rackPlacements array length
    if (rackPlacements) {
      if (!Array.isArray(rackPlacements)) {
        return res.status(400).json({ error: 'rackPlacements must be an array' });
      }
      if (rackPlacements.length > MAX_RACK_PLACEMENTS) {
        return res.status(400).json({ error: `Maximum ${MAX_RACK_PLACEMENTS} rack placements allowed` });
      }
      // Validate that referenced racks belong to this cellar
      const rackIds = [...new Set(rackPlacements.map(rp => rp.rack).filter(Boolean))];
      if (rackIds.length > 0) {
        const validCount = await Rack.countDocuments({
          _id: { $in: rackIds },
          cellar: req.cellar._id,
          deletedAt: null,
        });
        if (validCount !== rackIds.length) {
          return res.status(400).json({ error: 'One or more rack IDs do not belong to this cellar' });
        }
      }
    }

    const update = {};
    if (roomDimensions) update.roomDimensions = roomDimensions;
    if (rackPlacements) update.rackPlacements = rackPlacements;

    const layout = await CellarLayout.findOneAndUpdate(
      { cellar: req.cellar._id },
      { $set: update, $setOnInsert: { cellar: req.cellar._id } },
      { upsert: true, new: true, runValidators: true }
    );

    res.json({ layout });
  } catch (err) {
    console.error('Save cellar layout error:', err.message, err.errors ? JSON.stringify(err.errors) : '');
    const msg = err.name === 'ValidationError'
      ? `Validation: ${Object.values(err.errors || {}).map(e => e.message).join(', ')}`
      : 'Failed to save cellar layout';
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
