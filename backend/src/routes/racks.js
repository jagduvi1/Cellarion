const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { getCellarRole } = require('../utils/cellarAccess');

const router = express.Router();
router.use(requireAuth);

// GET /api/racks?cellar=:id  — list racks for a cellar (owner, editor, viewer)
router.get('/', async (req, res) => {
  try {
    const { cellar } = req.query;
    if (!cellar) return res.status(400).json({ error: 'cellar query param required' });

    const cellarDoc = await Cellar.findById(cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role) return res.status(404).json({ error: 'Cellar not found' });

    const racks = await Rack.find({ cellar, deletedAt: null })
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
router.post('/', async (req, res) => {
  try {
    const { cellar, name, rows, cols } = req.body;
    if (!cellar || !name) return res.status(400).json({ error: 'cellar and name are required' });

    const cellarDoc = await Cellar.findById(cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to create racks in this cellar' });
    }

    // Racks are owned by the cellar owner
    const rack = new Rack({
      cellar,
      user: cellarDoc.user,
      name,
      rows: rows || 4,
      cols: cols || 8
    });

    await rack.save();
    res.status(201).json({ rack });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A rack with that name already exists in this cellar' });
    console.error('Create rack error:', err);
    res.status(500).json({ error: 'Failed to create rack' });
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
    const { bottleId } = req.body;
    if (!bottleId) return res.status(400).json({ error: 'bottleId required' });

    const rack = await Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to modify rack slots' });
    }

    const maxPos = rack.rows * rack.cols;
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
    console.error('Assign slot error:', err);
    res.status(500).json({ error: 'Failed to assign slot' });
  }
});

// POST /api/racks/:id/slots/:position/consume  — soft-remove the bottle in a slot (owner or editor)
router.post('/:id/slots/:position/consume', async (req, res) => {
  try {
    const position = parseInt(req.params.position, 10);

    const rack = await Rack.findById(req.params.id);
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

    const rack = await Rack.findById(req.params.id);
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
