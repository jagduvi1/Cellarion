const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const Cellar = require('../../models/Cellar');
const Rack = require('../../models/Rack');
const Bottle = require('../../models/Bottle');
const { logAudit } = require('../../services/audit');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');
const { escapeRegex } = require('../../utils/sanitize');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// ---------------------------------------------------------------------------
// GET /api/admin/cellars/deleted?limit=50&offset=0&search=
// List all soft-deleted cellars across all users
// ---------------------------------------------------------------------------
router.get('/deleted', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query, { limit: 50, maxLimit: 200 });

    const filter = { deletedAt: { $ne: null } };
    if (req.query.search) {
      const escaped = escapeRegex(req.query.search.trim());
      filter.name = new RegExp(escaped, 'i');
    }

    const [cellars, total] = await Promise.all([
      Cellar.find(filter)
        .sort({ deletedAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate('user', 'username email')
        .lean(),
      Cellar.countDocuments(filter),
    ]);

    res.json({ cellars, total, limit, offset });
  } catch (error) {
    console.error('[admin/cellars] list deleted error:', error);
    res.status(500).json({ error: 'Failed to load deleted cellars' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/cellars/:id/restore
// Restore a soft-deleted cellar; renames it to "RESTORED - <original name>"
// to avoid conflicts with any active cellar the owner may have created since.
// ---------------------------------------------------------------------------
router.post('/:id/restore', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findOne({ _id: req.params.id, deletedAt: { $ne: null } });
    if (!cellar) {
      return res.status(404).json({ error: 'Deleted cellar not found' });
    }

    const restoredName = `RESTORED - ${cellar.name}`;
    cellar.name = restoredName;
    cellar.deletedAt = null;
    await cellar.save();

    // Restore all racks that were cascade-deleted with this cellar
    await Rack.updateMany({ cellar: cellar._id, deletedAt: { $ne: null } }, { $set: { deletedAt: null } });

    logAudit(req, 'cellar.restore', { cellarId: cellar._id }, { name: restoredName, owner: cellar.user });

    res.json({ cellar });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'The owner already has an active cellar with that restored name. Please contact them to rename it first.' });
    }
    console.error('[admin/cellars] restore error:', error);
    res.status(500).json({ error: 'Failed to restore cellar' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/cellars/:id
// Permanently delete a soft-deleted cellar and all its racks and bottles.
// Only works on cellars that are already soft-deleted (deletedAt != null).
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findOne({ _id: req.params.id, deletedAt: { $ne: null } });
    if (!cellar) {
      return res.status(404).json({ error: 'Deleted cellar not found' });
    }

    const [rackResult, bottleResult] = await Promise.all([
      Rack.deleteMany({ cellar: cellar._id }),
      Bottle.deleteMany({ cellar: cellar._id }),
    ]);

    await cellar.deleteOne();

    logAudit(req, 'cellar.permanent_delete', { cellarId: cellar._id }, {
      name: cellar.name,
      owner: cellar.user,
      racksDeleted: rackResult.deletedCount,
      bottlesDeleted: bottleResult.deletedCount,
    });

    res.json({ deleted: true, racksDeleted: rackResult.deletedCount, bottlesDeleted: bottleResult.deletedCount });
  } catch (error) {
    console.error('[admin/cellars] permanent delete error:', error);
    res.status(500).json({ error: 'Failed to permanently delete cellar' });
  }
});

module.exports = router;
