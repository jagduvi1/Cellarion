/**
 * /api/admin/ai-budget-requests — admin review of AI-budget increase requests.
 *
 *   GET  /            — list requests (?status=pending|approved|denied|decided),
 *                       paginated, with requester basics populated.
 *   PATCH /:id        — { action: 'approve'|'deny', grantedMax?, days? }
 *                       approve: writes a time-boxed aiBudgetOverride onto the
 *                       requesting User (max clamped 100–50000, default 2000;
 *                       days clamped 1–30, default 7) and notifies the user.
 *                       deny: closes the request with a neutral notification.
 *
 * Query-filter values are always literals or ObjectId casts — never raw
 * request input (CodeQL query-injection rule).
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const AiBudgetRequest = require('../../models/AiBudgetRequest');
const User = require('../../models/User');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');
const { createNotification } = require('../../services/notifications');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');

router.use(requireAuth, requireRole('admin'));

// Keep in sync with the AiBudgetRequest schema enum. 'decided' is a
// list-only alias for approved+denied (the admin page's second tab).
const REQUEST_STATUSES = ['pending', 'approved', 'denied'];

const GRANT_MAX_DEFAULT = 2000;
const GRANT_MAX_MIN = 100;
const GRANT_MAX_MAX = 50000;
const GRANT_DAYS_DEFAULT = 7;
const GRANT_DAYS_MIN = 1;
const GRANT_DAYS_MAX = 30;

function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// GET /api/admin/ai-budget-requests — list, newest first
router.get('/', async (req, res) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 100 });

    // Filter values come from static arrays, never from the request.
    const statusIdx = REQUEST_STATUSES.indexOf(String(req.query.status || ''));
    const filter = {};
    if (statusIdx !== -1) {
      filter.status = REQUEST_STATUSES[statusIdx];
    } else if (String(req.query.status || '') === 'decided') {
      filter.status = { $in: [REQUEST_STATUSES[1], REQUEST_STATUSES[2]] };
    }

    const [requests, total] = await Promise.all([
      AiBudgetRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate('user', 'username email')
        .populate('decidedBy', 'username')
        .lean(),
      AiBudgetRequest.countDocuments(filter),
    ]);

    res.json({ requests, total, page, limit });
  } catch (err) {
    console.error('Admin list AI budget requests error:', err);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

// PATCH /api/admin/ai-budget-requests/:id — approve or deny
router.patch('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const requestId = new mongoose.Types.ObjectId(req.params.id);

    const action = req.body.action === 'approve' ? 'approve'
      : req.body.action === 'deny' ? 'deny'
      : null;
    if (!action) return res.status(400).json({ error: 'action must be approve or deny' });

    // Atomically CLAIM the pending request so only the first of two concurrent
    // approve/deny decisions wins (audit BUG 6: the old findById → check status
    // → save was a check-then-act race — both admins passed the check, so a
    // deny could land after an approve and record 'denied' while the approve's
    // override stayed live on the user). A null result means already-decided
    // (409) or never-existed (404).
    const now = new Date();
    const decideConflict = async () => {
      const exists = await AiBudgetRequest.exists({ _id: requestId });
      return exists
        ? res.status(409).json({ error: 'Request has already been decided' })
        : res.status(404).json({ error: 'Request not found' });
    };

    let request;
    if (action === 'approve') {
      const grantedMax = clampInt(req.body.grantedMax, GRANT_MAX_DEFAULT, GRANT_MAX_MIN, GRANT_MAX_MAX);
      const days = clampInt(req.body.days, GRANT_DAYS_DEFAULT, GRANT_DAYS_MIN, GRANT_DAYS_MAX);
      const grantedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

      request = await AiBudgetRequest.findOneAndUpdate(
        { _id: requestId, status: 'pending' },
        { $set: { status: 'approved', decidedBy: req.user.id, decidedAt: now, grantedMax, grantedUntil } },
        { new: true }
      );
      if (!request) return decideConflict();

      // Grant the override ONLY after winning the claim, so a losing racer can
      // never write it.
      await User.updateOne(
        { _id: request.user },
        { $set: { aiBudgetOverride: { max: grantedMax, expiresAt: grantedUntil } } }
      );

      logAudit(req, 'admin.aiBudget.approve',
        { type: 'AiBudgetRequest', id: request._id },
        { userId: request.user, grantedMax, days }
      );

      createNotification(
        request.user,
        'ai_budget_approved',
        'AI limit increase approved',
        `Your daily AI lookup limit has been raised to ${grantedMax} until ${grantedUntil.toISOString().slice(0, 10)}. You can now retry the AI lookups in your import.`,
        null
      );
    } else {
      request = await AiBudgetRequest.findOneAndUpdate(
        { _id: requestId, status: 'pending' },
        { $set: { status: 'denied', decidedBy: req.user.id, decidedAt: now } },
        { new: true }
      );
      if (!request) return decideConflict();
      // Deny NEVER writes an aiBudgetOverride.

      logAudit(req, 'admin.aiBudget.deny',
        { type: 'AiBudgetRequest', id: request._id },
        { userId: request.user }
      );

      createNotification(
        request.user,
        'ai_budget_denied',
        'AI limit request reviewed',
        'Your request for a temporary AI limit increase was not granted this time. Your daily limit resets at midnight UTC, and your import continues to work with standard matching.',
        null
      );
    }

    await request.populate([
      { path: 'user', select: 'username email' },
      { path: 'decidedBy', select: 'username' },
    ]);
    res.json({ request });
  } catch (err) {
    console.error('Admin decide AI budget request error:', err);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

module.exports = router;
