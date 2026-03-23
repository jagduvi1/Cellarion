/**
 * Cellar Chat routes.
 *
 * POST /api/chat         – ask a question (non-streaming); rate-limited by plan quota
 * POST /api/chat/stream  – ask a question (streaming SSE); same rate limiting
 * GET  /api/chat/usage   – return current usage + limit for the current user
 *
 * Free plan: 5 questions per rolling 7-day window
 * Basic/Premium: daily limits (configurable via aiConfig)
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const aiChat = require('../services/aiChat');
const aiConfig = require('../config/aiConfig');
const ChatUsage = require('../models/ChatUsage');

const router = express.Router();

const FREE_WEEKLY_LIMIT = 5;

// Returns today's UTC date string 'YYYY-MM-DD'
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Returns the UTC date string for N days ago
function daysAgoUTC(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Returns a Date set to 90 days from now (retained for usage reporting)
function expiresAt() {
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
}

// Returns the daily limit for a given plan from the current aiConfig
function dailyLimitForPlan(plan) {
  const limits = aiConfig.get().chatDailyLimits || {};
  return limits[plan] ?? limits.free ?? 4;
}

/**
 * Returns { limit, used, period } for the given plan.
 * Free plan uses a rolling 7-day window; others use daily.
 */
async function getUsageForPlan(userId, plan) {
  if (plan === 'free') {
    const startDate = daysAgoUTC(6); // today minus 6 = 7-day window
    const docs = await ChatUsage.find({
      userId,
      date: { $gte: startDate },
    }).lean();
    const used = docs.reduce((sum, d) => sum + (d.count || 0), 0);
    return { limit: FREE_WEEKLY_LIMIT, used, period: 'weekly' };
  }
  const date = todayUTC();
  const doc = await ChatUsage.findOne({ userId, date }).lean();
  return { limit: dailyLimitForPlan(plan), used: doc?.count ?? 0, period: 'daily' };
}

/**
 * Shared input validation + rate-limit check.
 * Returns { message, useQueryExpansion, history, previousWines, plan, limit, date, usedBefore }
 * or sends an error response and returns null.
 */
async function validateAndCheckLimit(req, res) {
  const cfg = aiConfig.get();
  if (!cfg.chatEnabled) {
    res.status(503).json({ error: 'Cellar Chat is currently disabled.' });
    return null;
  }

  const { message, useQueryExpansion, history: rawHistory, previousWines: rawPreviousWines } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return null;
  }
  if (message.trim().length > 1000) {
    res.status(400).json({ error: 'message must be 1000 characters or fewer' });
    return null;
  }

  // Validate and sanitise conversation history
  const maxTurns = cfg.chatMaxHistoryTurns || 10;
  let history = [];
  if (Array.isArray(rawHistory)) {
    for (const entry of rawHistory.slice(-maxTurns)) {
      if (entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string') {
        history.push({ role: entry.role, content: entry.content.slice(0, 2000) });
      }
    }
  }

  const previousWines = typeof rawPreviousWines === 'string'
    ? rawPreviousWines.slice(0, 5000)
    : null;

  const plan = req.user.plan || 'free';
  const date = todayUTC();

  const { limit, used: usedBefore, period } = await getUsageForPlan(req.user.id, plan);

  if (usedBefore >= limit) {
    const resetMsg = period === 'weekly'
      ? 'Try again in a few days.'
      : 'Resets at midnight UTC.';
    res.status(429).json({
      error: `You've reached your ${period} limit of ${limit} question${limit === 1 ? '' : 's'}. ${resetMsg}`,
      used: usedBefore,
      limit,
      period,
    });
    return null;
  }

  // Pre-debit: increment now to block concurrent requests
  await ChatUsage.findOneAndUpdate(
    { userId: req.user.id, date },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: expiresAt() } },
    { upsert: true }
  );

  return {
    message: message.trim(),
    useQueryExpansion: useQueryExpansion !== false,
    history,
    previousWines,
    plan,
    limit,
    period,
    date,
    usedBefore,
  };
}

// ---------------------------------------------------------------------------
// GET /api/chat/usage
// ---------------------------------------------------------------------------
router.get('/usage', requireAuth, async (req, res) => {
  try {
    const plan = req.user.plan || 'free';
    const { limit, used, period } = await getUsageForPlan(req.user.id, plan);
    res.json({ used, limit, plan, period });
  } catch (err) {
    console.error('[chat] usage error:', err);
    res.status(500).json({ error: 'Failed to load usage' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat (non-streaming)
// ---------------------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  const validated = await validateAndCheckLimit(req, res);
  if (!validated) return;

  const { message, useQueryExpansion, history, previousWines, date, usedBefore, limit, period } = validated;

  try {
    const result = await aiChat.chat(req.user.id, message, {
      useQueryExpansion,
      history,
      previousWines,
    });

    if (result.usage) {
      ChatUsage.findOneAndUpdate(
        { userId: req.user.id, date },
        { $inc: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }
      ).catch(err => console.warn('[chat] token tracking error:', err.message));
    }

    res.json({ ...result, used: usedBefore + 1, limit, period });
  } catch (err) {
    await ChatUsage.findOneAndUpdate(
      { userId: req.user.id, date },
      { $inc: { count: -1 } }
    );
    const status = err.status || 500;
    if (status === 503) return res.status(503).json({ error: err.message });
    console.error('[chat] Error:', err);
    res.status(500).json({ error: 'Failed to generate recommendation' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/stream (streaming SSE)
// ---------------------------------------------------------------------------
router.post('/stream', requireAuth, async (req, res) => {
  const validated = await validateAndCheckLimit(req, res);
  if (!validated) return;

  const { message, useQueryExpansion, history, previousWines, date, usedBefore, limit, period } = validated;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx buffering
  res.flushHeaders();

  // Send usage info as the first event so frontend has it immediately
  res.write(`event: usage\ndata: ${JSON.stringify({ used: usedBefore + 1, limit, period })}\n\n`);

  try {
    const result = await aiChat.chatStream(req.user.id, message, {
      useQueryExpansion,
      history,
      previousWines,
    }, res);

    // Track token usage (best-effort)
    if (result?.usage) {
      ChatUsage.findOneAndUpdate(
        { userId: req.user.id, date },
        { $inc: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }
      ).catch(err => console.warn('[chat] token tracking error:', err.message));
    }
  } catch (err) {
    // Refund the debit
    await ChatUsage.findOneAndUpdate(
      { userId: req.user.id, date },
      { $inc: { count: -1 } }
    );

    // If headers already flushed, send error as SSE event
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message || 'Failed to generate recommendation' })}\n\n`);
      res.end();
    }
  }
});

module.exports = router;
