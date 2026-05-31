const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const AuditLog = require('../../models/AuditLog');
const { parsePagination } = require('../../utils/pagination');
const { SECURITY_EVENT_ACTIONS } = require('../../services/securityAlertJob');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/audit - Full audit log with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const { action, userId, from, to, security } = req.query;
    const { limit, offset, page } = parsePagination(req.query, { limit: 50, maxLimit: 200 });

    const filter = {};

    // `security=1` restricts to the exact set of security-relevant actions that
    // drive the SuperAdmin nav badge (failed logins, account lockouts, rate-limit
    // hits). Single source of truth: SECURITY_EVENT_ACTIONS. Takes precedence
    // over the free-text `action` filter so the toggle is unambiguous.
    if (security === '1' || security === 'true') {
      filter.action = { $in: SECURITY_EVENT_ACTIONS };
    } else if (action) {
      if (typeof action !== 'string' || !/^[\w.]+$/.test(action)) {
        return res.status(400).json({ error: 'Invalid action filter' });
      }
      filter.action = action;
    }
    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'Invalid userId filter' });
      }
      filter['actor.userId'] = userId;
    }

    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = new Date(from);
      if (to)   filter.timestamp.$lte = new Date(to);
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .populate('actor.userId', 'username email'),
      AuditLog.countDocuments(filter)
    ]);

    res.json({ total, page, limit, logs });
  } catch (error) {
    console.error('Get audit log error:', error);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

module.exports = router;
