const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const AuditLog = require('../../models/AuditLog');
const User = require('../../models/User');
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
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid "from" date' });
        filter.timestamp.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid "to" date' });
        filter.timestamp.$lte = d;
      }
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .populate('actor.userId', 'username email')
        .lean(),
      AuditLog.countDocuments(filter)
    ]);

    // Sign-up, sign-in and the like happen before anyone is signed in: no
    // actor, the account is the row's resource. Name it, so the row does not
    // read as anonymous. (Gone once the account is deleted — erased with it.)
    const aboutIds = [...new Set(logs
      .filter((l) => !l.actor?.userId && l.resource?.type === 'user' && l.resource.id)
      .map((l) => String(l.resource.id)))];
    if (aboutIds.length) {
      const users = await User.find({ _id: { $in: aboutIds } }, 'username').lean();
      const names = new Map(users.map((u) => [String(u._id), u.username]));
      for (const l of logs) {
        const name = !l.actor?.userId && l.resource?.type === 'user' && l.resource.id
          ? names.get(String(l.resource.id)) : null;
        if (name) l.about = { username: name };
      }
    }

    res.json({ total, page, limit, logs });
  } catch (error) {
    console.error('Get audit log error:', error);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

module.exports = router;
