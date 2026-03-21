const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireCellarAccess } = require('../middleware/cellarAccess');
const Rack = require('../models/Rack');
const { RACK_TYPES } = require('../models/Rack');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const CellarLayout = require('../models/CellarLayout');
const { getCellarRole } = require('../utils/cellarAccess');
const { getMaxPosition } = require('../utils/rackGeometry');

const router = express.Router();
router.use(requireAuth);

const MAX_MODULES = 50;

// GET /api/racks?cellar=:id  — list racks for a cellar (owner, editor, viewer)
router.get('/', requireCellarAccess('viewer'), async (req, res) => {
  try {
    const racks = await Rack.find({ cellar: req.cellar._id, deletedAt: null })
      .populate({
        path: 'slots.bottle',
        populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
      });

    res.json({ racks });
  } catch (err) {
    console.error('Get racks error:', err);
    res.status(500).json({ error: 'Failed to get racks' });
  }
});

// POST /api/racks  — create a rack (owner or editor)
router.post('/', requireCellarAccess('editor'), async (req, res) => {
  try {
    const { name, rows, cols, type, typeConfig, isModular, modules } = req.body;
    if (!name) return res.status(400).json({ error: 'cellar and name are required' });

    // Validate modular rack modules
    if (isModular && modules) {
      if (!Array.isArray(modules) || modules.length === 0) {
        return res.status(400).json({ error: 'Modular racks must have at least one module' });
      }
      if (modules.length > MAX_MODULES) {
        return res.status(400).json({ error: `Maximum ${MAX_MODULES} modules allowed per rack` });
      }
      for (const m of modules) {
        if (!m.type || !RACK_TYPES.includes(m.type)) {
          return res.status(400).json({ error: `Invalid module type: ${m.type}` });
        }
      }
    } else if (type && !RACK_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid rack type. Must be one of: ${RACK_TYPES.join(', ')}` });
    }

    // Racks are owned by the cellar owner
    const rackData = {
      cellar: req.cellar._id,
      user: req.cellar.user,
      name,
    };

    if (isModular && modules) {
      rackData.isModular = true;
      rackData.modules = modules;
    } else {
      rackData.type = type || 'grid';
      rackData.rows = rows || 4;
      rackData.cols = cols || 8;
      if (typeConfig) rackData.typeConfig = typeConfig;
    }

    const rack = new Rack(rackData);

    await rack.save();
    res.status(201).json({ rack });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A rack with that name already exists in this cellar' });
    console.error('Create rack error:', err);
    res.status(500).json({ error: 'Failed to create rack' });
  }
});

// PUT /api/racks/:id  — update rack name, type, dimensions (owner or editor)
router.put('/:id', async (req, res) => {
  try {
    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to modify this rack' });
    }

    const { name, type, rows, cols, typeConfig, isModular, modules } = req.body;

    // Validate modular modules if provided
    if (isModular && modules) {
      if (!Array.isArray(modules) || modules.length === 0) {
        return res.status(400).json({ error: 'Modular racks must have at least one module' });
      }
      if (modules.length > MAX_MODULES) {
        return res.status(400).json({ error: `Maximum ${MAX_MODULES} modules allowed per rack` });
      }
      for (const m of modules) {
        if (!m.type || !RACK_TYPES.includes(m.type)) {
          return res.status(400).json({ error: `Invalid module type: ${m.type}` });
        }
      }
    } else if (type && !RACK_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid rack type. Must be one of: ${RACK_TYPES.join(', ')}` });
    }

    if (name !== undefined) rack.name = name;
    if (isModular !== undefined) rack.isModular = isModular;
    if (modules !== undefined) rack.modules = modules;
    if (type !== undefined) rack.type = type;
    if (rows !== undefined) rack.rows = rows;
    if (cols !== undefined) rack.cols = cols;
    if (typeConfig !== undefined) rack.typeConfig = typeConfig;

    // Validate that existing slots still fit within new dimensions
    const newMax = getMaxPosition(rack);
    const outOfBounds = rack.slots.filter(s => s.position > newMax);
    if (outOfBounds.length > 0) {
      return res.status(400).json({
        error: `Cannot resize: ${outOfBounds.length} bottle(s) are in positions that would be removed. Clear them first.`
      });
    }

    await rack.save();
    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    res.json({ rack });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A rack with that name already exists in this cellar' });
    if (err.name === 'VersionError') {
      return res.status(409).json({ error: 'This rack was modified by another request. Please refresh and try again.' });
    }
    console.error('Update rack error:', err);
    res.status(500).json({ error: 'Failed to update rack' });
  }
});

// DELETE /api/racks/:id  — soft-delete a rack (owner only); data retained 30 days
router.delete('/:id', async (req, res) => {
  try {
    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only the cellar owner can delete racks' });
    }

    if (rack.slots.length > 0) {
      return res.status(400).json({ error: `Remove all ${rack.slots.length} bottle${rack.slots.length !== 1 ? 's' : ''} from this rack before deleting it` });
    }

    rack.deletedAt = new Date();
    await rack.save();

    // Remove this rack from the cellar room layout (if present)
    await CellarLayout.updateOne(
      { cellar: rack.cellar },
      { $pull: { rackPlacements: { rack: rack._id } } }
    );

    res.json({ message: 'Rack deleted' });
  } catch (err) {
    console.error('Delete rack error:', err);
    res.status(500).json({ error: 'Failed to delete rack' });
  }
});

// PUT /api/racks/:id/slots/:position  — assign a bottle to a slot (owner or editor)
router.put('/:id/slots/:position', async (req, res) => {
  try {
    const position = parseInt(req.params.position, 10);
    if (isNaN(position)) return res.status(400).json({ error: 'Invalid position' });
    const { bottleId } = req.body;
    if (!bottleId) return res.status(400).json({ error: 'bottleId required' });

    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to modify rack slots' });
    }

    const maxPos = getMaxPosition(rack);
    if (position < 1 || position > maxPos) {
      return res.status(400).json({ error: `Position must be 1–${maxPos}` });
    }

    // Verify the bottle belongs to this cellar
    const bottle = await Bottle.findOne({ _id: bottleId, cellar: rack.cellar });
    if (!bottle) return res.status(404).json({ error: 'Bottle not found in this cellar' });

    // Remove existing assignment for this position, then add new one
    rack.slots = rack.slots.filter(s => s.position !== position);
    rack.slots.push({ position, bottle: bottleId });
    await rack.save();

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    res.json({ rack });
  } catch (err) {
    if (err.name === 'VersionError') {
      return res.status(409).json({ error: 'This rack was modified by another request. Please refresh and try again.' });
    }
    console.error('Assign slot error:', err);
    res.status(500).json({ error: 'Failed to assign slot' });
  }
});

// POST /api/racks/:id/slots/:position/consume  — soft-remove the bottle in a slot (owner or editor)
router.post('/:id/slots/:position/consume', async (req, res) => {
  try {
    const position = parseInt(req.params.position, 10);
    if (isNaN(position)) return res.status(400).json({ error: 'Invalid position' });

    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to consume bottles in this cellar' });
    }

    const slot = rack.slots.find(s => s.position === position);
    if (!slot) return res.status(404).json({ error: 'Slot is empty' });

    // Soft-remove the bottle (move to history)
    const bottle = await Bottle.findById(slot.bottle);
    if (bottle) {
      bottle.status = 'drank';
      bottle.consumedAt = new Date();
      bottle.consumedReason = 'drank';
      await bottle.save();
    }

    // Remove the slot assignment
    rack.slots = rack.slots.filter(s => s.position !== position);
    await rack.save();

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    res.json({ rack });
  } catch (err) {
    console.error('Consume slot error:', err);
    res.status(500).json({ error: 'Failed to consume bottle' });
  }
});

// DELETE /api/racks/:id/slots/:position  — clear a slot (owner or editor)
router.delete('/:id/slots/:position', async (req, res) => {
  try {
    const position = parseInt(req.params.position, 10);
    if (isNaN(position)) return res.status(400).json({ error: 'Invalid position' });

    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to modify rack slots' });
    }

    rack.slots = rack.slots.filter(s => s.position !== position);
    await rack.save();

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    res.json({ rack });
  } catch (err) {
    console.error('Clear slot error:', err);
    res.status(500).json({ error: 'Failed to clear slot' });
  }
});

module.exports = router;
