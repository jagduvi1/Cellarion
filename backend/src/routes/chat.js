/**
 * Cellar Chat routes.
 *
 * POST /api/chat        – ask a question; rate-limited by plan daily quota
 * GET  /api/chat/usage  – return today's usage + limit for the current user
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const aiChat = require('../services/aiChat');
const aiConfig = require('../config/aiConfig');
const ChatUsage = require('../models/ChatUsage');

const router = express.Router();

// Returns today's UTC date string 'YYYY-MM-DD'
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Returns a Date set to 90 days from now (retained for usage reporting)
function expiresAt() {
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
}

// Returns the daily limit for a given plan from the current aiConfig
function limitForPlan(plan) {
  const limits = aiConfig.get().chatDailyLimits || {};
  return limits[plan] ?? limits.free ?? 4;
}

// ---------------------------------------------------------------------------
// GET /api/chat/usage
// ---------------------------------------------------------------------------
router.get('/usage', requireAuth, async (req, res) => {
  try {
    const plan = req.user.plan || 'free';
    const limit = limitForPlan(plan);
    const date = todayUTC();
    const usage = await ChatUsage.findOne({ userId: req.user.id, date }).lean();
    res.json({ used: usage?.count ?? 0, limit, plan });
  } catch (err) {
    console.error('[chat] usage error:', err);
    res.status(500).json({ error: 'Failed to load usage' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  const cfg = aiConfig.get();
  if (!cfg.chatEnabled) {
    return res.status(503).json({ error: 'Cellar Chat is currently disabled.' });
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.trim().length > 1000) {
    return res.status(400).json({ error: 'message must be 1000 characters or fewer' });
  }

  const plan = req.user.plan || 'free';
  const limit = limitForPlan(plan);
  const date = todayUTC();

  // Check current usage before proceeding
  const usageDoc = await ChatUsage.findOne({ userId: req.user.id, date }).lean();
  const usedBefore = usageDoc?.count ?? 0;

  if (usedBefore >= limit) {
    return res.status(429).json({
      error: `You've reached your daily limit of ${limit} question${limit === 1 ? '' : 's'}. Resets at midnight UTC.`,
      used: usedBefore,
      limit,
    });
  }

  // Pre-debit: increment now to block concurrent requests
  await ChatUsage.findOneAndUpdate(
    { userId: req.user.id, date },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: expiresAt() } },
    { upsert: true }
  );

  try {
    const result = await aiChat.chat(req.user.id, message.trim());

    // Persist token usage asynchronously (best-effort — don't fail the request)
    if (result.usage) {
      ChatUsage.findOneAndUpdate(
        { userId: req.user.id, date },
        { $inc: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }
      ).catch(err => console.warn('[chat] token tracking error:', err.message));
    }

    res.json({ ...result, used: usedBefore + 1, limit });
  } catch (err) {
    // Refund the debit if the AI call failed (service error, not user error)
    await ChatUsage.findOneAndUpdate(
      { userId: req.user.id, date },
      { $inc: { count: -1 } }
    );
    const status = err.status || 500;
    if (status === 503) {
      return res.status(503).json({ error: err.message });
    }
    console.error('[chat] Error:', err);
    res.status(500).json({ error: 'Failed to generate recommendation' });
  }
});

module.exports = router;
