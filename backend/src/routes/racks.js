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
const { placeBottleInRack, clearRackSlot } = require('../services/rackOps');
const { isValidId } = require('../utils/validation');
const { logAudit } = require('../services/audit');
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');

const router = express.Router();

const MAX_MODULES = 50;

/**
 * Serialize rack doc(s) with a maturityStatus attached to every populated
 * slot bottle (same classification the cellar list attaches per bottle), so
 * the rack views can color slots by drink window. Accepts a single rack or
 * an array; returns plain objects ready for res.json.
 */
async function withMaturity(rackOrRacks) {
  const rackDocs = Array.isArray(rackOrRacks) ? rackOrRacks : [rackOrRacks];
  const bottles = rackDocs.flatMap(r => (r.slots || []).map(s => s.bottle).filter(Boolean));
  const profileMap = await buildProfileMap(bottles);
  const out = rackDocs.map(r => {
    const obj = typeof r.toObject === 'function' ? r.toObject() : r;
    for (const s of obj.slots || []) {
      if (s.bottle && s.bottle._id) {
        s.bottle.maturityStatus = classifyMaturity(s.bottle, profileMap) || null;
      }
    }
    return obj;
  });
  return Array.isArray(rackOrRacks) ? out : out[0];
}

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
    // Only members of the rack's cellar may resolve the tag — anyone else gets
    // the same 404 as a nonexistent rack, so this endpoint is not an existence
    // oracle for rack IDs or a rack→cellar linkage leak (audit L-4 / I-9).
    const cellar = await Cellar.findById(rack.cellar).select('user members deletedAt');
    if (!cellar || cellar.deletedAt || !getCellarRole(cellar, req.user.id)) {
      return res.status(404).json({ error: 'Rack not found' });
    }
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

    res.json({ racks: await withMaturity(racks) });
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
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
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

    const { name, type, rows, cols, typeConfig, isModular, modules, rfidTag, zones } = req.body;

    // Validate zones if provided: bounded count, named, valid hex color,
    // integer positions, and no position in more than one zone.
    if (zones !== undefined) {
      if (!Array.isArray(zones) || zones.length > 12) {
        return res.status(400).json({ error: 'zones must be an array of at most 12 zones' });
      }
      const seenPositions = new Set();
      for (const z of zones) {
        if (!z || typeof z.name !== 'string' || !z.name.trim() || z.name.trim().length > 40) {
          return res.status(400).json({ error: 'Each zone needs a name (max 40 characters)' });
        }
        if (z.color != null && !/^#[0-9a-fA-F]{6}$/.test(z.color)) {
          return res.status(400).json({ error: 'Zone color must be a #rrggbb hex value' });
        }
        if (!Array.isArray(z.positions)) {
          return res.status(400).json({ error: 'Each zone needs a positions array' });
        }
        for (const p of z.positions) {
          if (!Number.isInteger(p) || p < 1) {
            return res.status(400).json({ error: 'Zone positions must be whole numbers ≥ 1' });
          }
          if (seenPositions.has(p)) {
            return res.status(400).json({ error: `Position ${p} is in more than one zone` });
          }
          seenPositions.add(p);
        }
      }
    }

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
    if (zones !== undefined) {
      rack.zones = zones.map(z => ({
        name: z.name.trim(),
        color: z.color || undefined,
        positions: [...new Set(z.positions)].sort((a, b) => a - b),
      }));
    }

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

    // Same for zone positions — a resize just shrinks the zones.
    for (const z of rack.zones || []) {
      if (z.positions.some(p => p > newMax)) {
        z.positions = z.positions.filter(p => p <= newMax);
      }
    }

    await rack.save();
    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    logAudit(req, 'rack.update', { type: 'rack', id: rack._id });
    res.json({ rack: await withMaturity(rack) });
  } catch (err) {
    if (err.code === 11000) {
      // Two unique indexes can throw here — report the right conflict.
      const isTagConflict = err.keyPattern?.rfidTag || /rfidTag/.test(err.message || '');
      return res.status(409).json({
        error: isTagConflict
          ? 'That NFC tag is already linked to another rack. Unlink it there first.'
          : 'A rack with that name already exists in this cellar'
      });
    }
    if (err.name === 'VersionError') {
      return res.status(409).json({ error: 'This rack was modified by another request. Please refresh and try again.' });
    }
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
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

    // Free the NFC tag: the unique rfidTag index has no deletedAt filter, so
    // a tag left on a soft-deleted rack would block linking it to any new
    // rack until the retention purge. (Restoring the cellar therefore brings
    // the rack back without its tag — re-link via NFC settings.)
    rack.rfidTag = undefined;

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

    // Placement invariants + slot write are shared with the MCP place tool.
    const result = await placeBottleInRack(rack, position, bottleId, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });
    res.json({ rack: await withMaturity(rack) });
  } catch (err) {
    console.error('Assign slot error:', err);
    res.status(500).json({ error: 'Failed to assign slot' });
  }
});

// POST /api/racks/:id/slots/:position/move  — move a bottle to another slot
// in the same rack (owner or editor). Body: { toPosition }. If the target
// slot is occupied the two bottles swap. One save() under the rack's
// optimistic-concurrency guard, so the move/swap is atomic.
router.post('/:id/slots/:position/move', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const from = parseInt(req.params.position, 10);
    const to = parseInt(req.body?.toPosition, 10);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'Invalid position' });
    if (from === to) return res.status(400).json({ error: 'Source and target are the same slot' });

    const rack = await Rack.findOne({ _id: req.params.id, deletedAt: null });
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const cellarDoc = await Cellar.findById(rack.cellar);
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to modify rack slots' });
    }

    const maxPos = getMaxPosition(rack);
    if (from < 1 || from > maxPos || to < 1 || to > maxPos) {
      return res.status(400).json({ error: `Position must be 1–${maxPos}` });
    }
    // Only the target needs the disabled check — an occupied source slot
    // that was later disabled must still be allowed to move its bottle out.
    if ((rack.disabledPositions || []).includes(to)) {
      return res.status(400).json({ error: 'This slot is disabled' });
    }

    const fromSlot = rack.slots.find(s => s.position === from);
    if (!fromSlot) return res.status(400).json({ error: 'Source slot is empty' });
    const toSlot = rack.slots.find(s => s.position === to);

    fromSlot.position = to;
    if (toSlot) toSlot.position = from; // occupied target → swap
    await rack.save();

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });

    logAudit(req, 'rack.slot_move', { type: 'rack', id: rack._id }, { from, to, swapped: !!toSlot });
    res.json({ rack: await withMaturity(rack) });
  } catch (err) {
    if (err.name === 'VersionError') {
      return res.status(409).json({ error: 'This rack was modified by another request. Please refresh and try again.' });
    }
    console.error('Move slot error:', err);
    res.status(500).json({ error: 'Failed to move bottle' });
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

    const result = await clearRackSlot(rack, position, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });

    await rack.populate({
      path: 'slots.bottle',
      populate: { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] }
    });
    res.json({ rack: await withMaturity(rack) });
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
    res.json({ rack: await withMaturity(rack) });
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
    res.json({ rack: await withMaturity(rack) });
  } catch (err) {
    if (err.name === 'VersionError') {
      return res.status(409).json({ error: 'This rack was modified by another request. Please refresh and try again.' });
    }
    console.error('Enable slot error:', err);
    res.status(500).json({ error: 'Failed to enable slot' });
  }
});

module.exports = router;
