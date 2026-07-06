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
const { isValidId } = require('../utils/validation');
const searchService = require('../services/search');
const { logAudit } = require('../services/audit');

const router = express.Router();

const MAX_MODULES = 50;

/**
 * Validate typeConfig.doubleHeightRows: grid racks (non-modular) only,
 * entries must be integers in [1, rows].
 *
 * POSITION NUMBERING CONTRACT (double-height rows): the base grid keeps
 * positions 1..rows*cols row-major EXACTLY as a plain grid — existing
 * bottles never move. Top-layer positions are APPENDED after rows*cols:
 * iterate valid double-height rows in ascending row order, each contributing
 * cols-1 positions left-to-right. Example 4x6 grid with doubleHeightRows
 * [2]: base 1..24 unchanged, top layer of row 2 = positions 25..29.
 * (The capacity math lives in utils/rackGeometry.js; the resize guard below
 * therefore also catches removing a double row while top-layer bottles are
 * still placed.)
 *
 * @returns {string|null} error message, or null when valid
 */
function validateDoubleHeightRows(typeConfig, effectiveType, effectiveRows, effectiveModular) {
  const dhr = typeConfig?.doubleHeightRows;
  if (dhr === undefined || dhr === null) return null;
  if (effectiveModular || (effectiveType || 'grid') !== 'grid') {
    return 'Double-height rows are only supported on grid racks';
  }
  if (!Array.isArray(dhr)) {
    return 'doubleHeightRows must be an array of row numbers';
  }
  for (const r of dhr) {
    if (!Number.isInteger(r) || r < 1 || r > effectiveRows) {
      return `doubleHeightRows entries must be whole row numbers between 1 and ${effectiveRows}`;
    }
  }
  return null;
}

// GET /api/racks/nfc/:id  — resolve a rack ID to its cellar (for NFC tag redirect)
// Requires auth so only logged-in users can follow NFC links.
router.get('/nfc/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null }).select('cellar');
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    // Check if rack is placed in the 3D room layout
    const layout = await CellarLayout.findOne({ cellar: rack.cellar }).lean();
    const inRoom = layout?.rackPlacements?.some(
      rp => rp.rack.toString() === rack._id.toString()
    ) || false;
    res.json({ cellarId: rack.cellar, rackId: rack._id, inRoom });
  } catch (err) {
    console.error('NFC rack lookup error:', err);
    res.status(500).json({ error: 'Failed to look up rack' });
  }
});

router.use(requireAuth);

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
      if (typeConfig) {
        const dhrError = validateDoubleHeightRows(typeConfig, rackData.type, rackData.rows, false);
        if (dhrError) return res.status(400).json({ error: dhrError });
        rackData.typeConfig = typeConfig;
      }
    }

    const rack = new Rack(rackData);

    await rack.save();
    logAudit(req, 'rack.create', { type: 'rack', id: rack._id });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to modify this rack' });
    }

    const { name, type, rows, cols, typeConfig, isModular, modules, rfidTag } = req.body;

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

    // Validate double-height rows against the rack's effective (post-update)
    // type/rows — the request may change any subset of the three fields.
    if (typeConfig !== undefined && typeConfig !== null) {
      const dhrError = validateDoubleHeightRows(
        typeConfig,
        type !== undefined ? type : rack.type,
        rows !== undefined ? rows : rack.rows,
        isModular !== undefined ? isModular : rack.isModular
      );
      if (dhrError) return res.status(400).json({ error: dhrError });
    }

    if (name !== undefined) rack.name = name;
    if (isModular !== undefined) rack.isModular = isModular;
    if (modules !== undefined) rack.modules = modules;
    if (type !== undefined) rack.type = type;
    if (rows !== undefined) rack.rows = rows;
    if (cols !== undefined) rack.cols = cols;
    if (typeConfig !== undefined) rack.typeConfig = typeConfig;
    // Unlink must $unset the field, not store null: the unique sparse index on
    // rfidTag still indexes explicit nulls, so two unlinked racks anywhere in
    // the DB would collide with E11000.
    if (rfidTag !== undefined) rack.rfidTag = rfidTag || undefined;

    // Validate that existing slots still fit within new dimensions
    const newMax = getMaxPosition(rack);
    const outOfBounds = rack.slots.filter(s => s.position > newMax);
    if (outOfBounds.length > 0) {
      return res.status(400).json({
        error: `Cannot resize: ${outOfBounds.length} bottle(s) are in positions that would be removed. Clear them first.`
      });
    }

    // Silently drop disabled positions beyond the new maximum — they address
    // cells that no longer exist after the resize.
    if ((rack.disabledPositions || []).some(p => p > newMax)) {
      rack.disabledPositions = rack.disabledPositions.filter(p => p <= newMax);
    }

    await rack.save();
    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    logAudit(req, 'rack.update', { type: 'rack', id: rack._id });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only the cellar owner can delete racks' });
    }

    // Clear all bottle slot assignments before soft-deleting
    if (rack.slots.length > 0) {
      rack.slots = [];
    }

    rack.deletedAt = new Date();
    await rack.save();

    // Remove this rack from the cellar room layout (if present)
    await CellarLayout.updateOne(
      { cellar: rack.cellar },
      { $pull: { rackPlacements: { rack: rack._id } } }
    );

    logAudit(req, 'rack.delete', { type: 'rack', id: rack._id });
    res.json({ message: 'Rack deleted' });
  } catch (err) {
    console.error('Delete rack error:', err);
    res.status(500).json({ error: 'Failed to delete rack' });
  }
});

// PUT /api/racks/:id/slots/:position  — assign a bottle to a slot (owner or editor)
router.put('/:id/slots/:position', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const position = parseInt(req.params.position, 10);
    if (isNaN(position)) return res.status(400).json({ error: 'Invalid position' });
    const { bottleId } = req.body;
    if (!isValidId(bottleId)) return res.status(400).json({ error: 'Valid bottleId required' });

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

    if ((rack.disabledPositions || []).includes(position)) {
      return res.status(400).json({ error: 'This slot is disabled' });
    }

    // Verify the bottle belongs to this cellar
    const bottle = await Bottle.findOne({ _id: bottleId, cellar: rack.cellar });
    if (!bottle) return res.status(404).json({ error: 'Bottle not found in this cellar' });

    // A bottle occupies at most one slot. Clear its placement in any OTHER
    // rack of this cellar first (this rack is handled in-memory below — an
    // external update to it would trip optimistic concurrency on save()).
    await Rack.updateMany(
      { _id: { $ne: rack._id }, cellar: rack.cellar, 'slots.bottle': bottleId },
      { $pull: { slots: { bottle: bottleId } } }
    );

    // Remove the target position's assignment and the bottle's old slot in
    // this rack (if any), then add the new assignment
    rack.slots = rack.slots.filter(
      s => s.position !== position && String(s.bottle) !== String(bottleId)
    );
    rack.slots.push({ position, bottle: bottleId });
    await rack.save();

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    logAudit(req, 'rack.slot_assign', { type: 'rack', id: rack._id });
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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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
      searchService.indexBottle(bottle._id);
    }

    // Remove the slot assignment
    rack.slots = rack.slots.filter(s => s.position !== position);
    await rack.save();

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    logAudit(req, 'rack.slot_consume', { type: 'rack', id: rack._id });
    res.json({ rack });
  } catch (err) {
    console.error('Consume slot error:', err);
    res.status(500).json({ error: 'Failed to consume bottle' });
  }
});

// DELETE /api/racks/:id/slots/:position  — clear a slot (owner or editor)
router.delete('/:id/slots/:position', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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

    logAudit(req, 'rack.slot_clear', { type: 'rack', id: rack._id });
    res.json({ rack });
  } catch (err) {
    console.error('Clear slot error:', err);
    res.status(500).json({ error: 'Failed to clear slot' });
  }
});

// POST /api/racks/:id/slots/:position/disable  — mark a slot as unusable (owner or editor)
router.post('/:id/slots/:position/disable', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const position = parseInt(req.params.position, 10);
    if (isNaN(position)) return res.status(400).json({ error: 'Invalid position' });

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

    if (rack.slots.some(s => s.position === position)) {
      return res.status(409).json({ error: 'This slot is occupied. Clear the slot first.' });
    }

    // $addToSet semantics — no duplicates
    if (!rack.disabledPositions.includes(position)) {
      rack.disabledPositions.push(position);
      await rack.save();
    }

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    logAudit(req, 'rack.slot_disable', { type: 'rack', id: rack._id });
    res.json({ rack });
  } catch (err) {
    if (err.name === 'VersionError') {
      return res.status(409).json({ error: 'This rack was modified by another request. Please refresh and try again.' });
    }
    console.error('Disable slot error:', err);
    res.status(500).json({ error: 'Failed to disable slot' });
  }
});

// DELETE /api/racks/:id/slots/:position/disable  — make a disabled slot usable again (owner or editor)
router.delete('/:id/slots/:position/disable', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const position = parseInt(req.params.position, 10);
    if (isNaN(position)) return res.status(400).json({ error: 'Invalid position' });

    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to modify rack slots' });
    }

    if (rack.disabledPositions.includes(position)) {
      rack.disabledPositions = rack.disabledPositions.filter(p => p !== position);
      await rack.save();
    }

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    logAudit(req, 'rack.slot_enable', { type: 'rack', id: rack._id });
    res.json({ rack });
  } catch (err) {
    if (err.name === 'VersionError') {
      return res.status(409).json({ error: 'This rack was modified by another request. Please refresh and try again.' });
    }
    console.error('Enable slot error:', err);
    res.status(500).json({ error: 'Failed to enable slot' });
  }
});

module.exports = router;
