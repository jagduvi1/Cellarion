/**
 * /api/ai-budget — user-side AI-budget escalation flow.
 *
 * When the shared per-user daily AI budget (services/aiBudget.js) runs out
 * mid-import, remaining rows fall back to fuzzy matching (aiSkipped). The
 * importer offers "Request higher limit" — that lands here:
 *
 *   POST /request  — create a pending AiBudgetRequest (one at a time per
 *                    user; a second POST while one is pending → 409) and
 *                    notify every admin. Admins decide it under
 *                    /api/admin/ai-budget-requests.
 *   GET  /status   — the effective daily max (override-aware), today's
 *                    usage, the active override (if any) and whether a
 *                    request is already pending — everything the importer
 *                    banner needs to render precisely.
 *
 * The global writeLimiter in app.js covers the POST; both routes require auth.
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const AiBudgetRequest = require('../models/AiBudgetRequest');
const AiUsage = require('../models/AiUsage');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { createNotifications } = require('../services/notifications');
const { getEffectiveDailyMax, todayUTC } = require('../services/aiBudget');
const { stripHtml } = require('../utils/sanitize');

router.use(requireAuth);

const MAX_REASON_LENGTH = 500;
// Sanity bound for the optional pendingRows metadata (import row counts).
const MAX_PENDING_ROWS = 100000;

// POST /api/ai-budget/request — ask an admin for a temporary budget increase
router.post('/request', async (req, res) => {
  try {
    // req.user.id comes from the verified JWT, but cast defensively so no
    // raw value ever reaches a query object (CodeQL: no user-tainted filters).
    const userId = new mongoose.Types.ObjectId(String(req.user.id));

    const reason = stripHtml(typeof req.body.reason === 'string' ? req.body.reason : '')
      .trim()
      .slice(0, MAX_REASON_LENGTH);

    const rawPending = Number(req.body.pendingRows);
    const pendingRows = Number.isFinite(rawPending)
      ? Math.min(Math.max(Math.round(rawPending), 0), MAX_PENDING_ROWS)
      : null;

    const existing = await AiBudgetRequest.findOne({ user: userId, status: 'pending' })
      .select('_id')
      .lean();
    if (existing) {
      return res.status(409).json({ error: 'You already have a pending request' });
    }

    let request;
    try {
      request = await AiBudgetRequest.create({
        user: userId,
        reason,
        requestedContext: { pendingRows },
      });
    } catch (err) {
      // Partial unique index (user + status:pending) makes the 409 race-safe:
      // a concurrent duplicate that slipped past the findOne lands here.
      if (err.code === 11000) {
        return res.status(409).json({ error: 'You already have a pending request' });
      }
      throw err;
    }

    logAudit(req, 'aiBudget.request.create',
      { type: 'AiBudgetRequest', id: request._id },
      { pendingRows }
    );

    // Notify every admin — same in-app notification system as wine requests;
    // fire-and-forget so a notification failure never breaks the request.
    const requester = await User.findById(userId).select('username').lean();
    const admins = await User.find({ roles: 'admin' }).select('_id').lean();
    createNotifications(admins.map(a => ({
      userId: a._id,
      type: 'ai_budget_request',
      title: 'AI budget increase requested',
      message: `${requester?.username || 'A user'} requested a temporary AI budget increase${reason ? `: "${reason}"` : '.'}`,
      link: '/admin/ai-budget-requests',
    })));

    res.status(201).json({
      request: {
        _id: request._id,
        status: request.status,
        reason: request.reason,
        createdAt: request.createdAt,
      },
    });
  } catch (err) {
    console.error('AI budget request error:', err);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// GET /api/ai-budget/status — effective limit + today's usage for the requester
router.get('/status', async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(String(req.user.id));

    const [{ max, override }, usage, pending] = await Promise.all([
      getEffectiveDailyMax(userId),
      AiUsage.findOne({ userId, date: todayUTC() }).select('count').lean(),
      AiBudgetRequest.exists({ user: userId, status: 'pending' }),
    ]);

    res.json({
      // 0 = unlimited (site-wide config)
      dailyMax: max,
      usedToday: usage?.count || 0,
      override: override ? { max: override.max, expiresAt: override.expiresAt } : null,
      pendingRequest: !!pending,
    });
  } catch (err) {
    console.error('AI budget status error:', err);
    res.status(500).json({ error: 'Failed to load AI budget status' });
  }
});

module.exports = router;
