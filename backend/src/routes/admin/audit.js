const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const AuditLog = require('../../models/AuditLog');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/audit - Full audit log with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const {
      action,
      userId,
      from,
      to,
      page = 1,
      limit = 50
    } = req.query;

    const filter = {};

    if (action) filter.action = action;
    if (userId) filter['actor.userId'] = userId;

    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = new Date(from);
      if (to)   filter.timestamp.$lte = new Date(to);
    }

    const parsedPage  = Math.max(parseInt(page)  || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const skip = (parsedPage - 1) * parsedLimit;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .populate('actor.userId', 'username email'),
      AuditLog.countDocuments(filter)
    ]);

    res.json({ total, page: parsedPage, limit: parsedLimit, logs });
  } catch (error) {
    console.error('Get audit log error:', error);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

module.exports = router;
