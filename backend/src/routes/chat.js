/**
 * Cellar Chat routes.
 *
 * POST /api/chat         – ask a question (non-streaming); rate-limited by supporter tier quota
 * POST /api/chat/stream  – ask a question (streaming SSE); same rate limiting
 * GET  /api/chat/usage   – return current usage + limit for the current user
 *
 * All tiers use a rolling 7-day window:
 *   Enthusiast (free): 5 questions / week
 *   Supporter:         50 questions / week
 *   Patron:            unlimited
 */

const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const aiChat = require('../services/aiChat');
const aiConfig = require('../config/aiConfig');
const ChatUsage = require('../models/ChatUsage');
const User = require('../models/User');
const { getPlanConfig } = require('../config/plans');
const { logAudit } = require('../services/audit');

const router = express.Router();

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

/**
 * Returns { limit, used, period } for the given plan.
 * Window size depends on the plan's chatPeriod ('daily' or 'weekly').
 * Patron (-1) = unlimited.
 */
async function getUsageForPlan(userId, plan) {
  const config = getPlanConfig(plan);
  const limit = config.chatQuota; // -1 = unlimited
  const period = config.chatPeriod || 'weekly';

  const startDate = period === 'daily' ? daysAgoUTC(0) : daysAgoUTC(6);
  const docs = await ChatUsage.find({
    userId,
    date: { $gte: startDate },
  }).lean();
  const used = docs.reduce((sum, d) => sum + (d.count || 0), 0);
  return { limit, used, period };
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

  const { message, useQueryExpansion, history: rawHistory, previousWines: rawPreviousWines, cellarIds: rawCellarIds } = req.body;
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

  // limit === -1 means unlimited (patron tier)
  if (limit !== -1 && usedBefore >= limit) {
    res.status(429).json({
      error: `You've reached your ${period} limit of ${limit} question${limit === 1 ? '' : 's'}. Try again ${period === 'daily' ? 'tomorrow' : 'in a few days'}.`,
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

  // Validate and resolve cellar scope
  let cellarIds = null;
  if (Array.isArray(rawCellarIds) && rawCellarIds.length > 0) {
    cellarIds = rawCellarIds.filter(id => mongoose.Types.ObjectId.isValid(id)).slice(0, 20);
    if (!cellarIds.length) cellarIds = null;
  } else if (rawCellarIds === undefined || rawCellarIds === null) {
    // Default to user's default cellar if set
    const user = await User.findById(req.user.id).select('preferences.defaultCellarId').lean();
    if (user?.preferences?.defaultCellarId) {
      cellarIds = [user.preferences.defaultCellarId.toString()];
    }
  }
  // rawCellarIds === [] (explicit empty array) means "search all cellars"

  return {
    message: message.trim(),
    useQueryExpansion: useQueryExpansion !== false,
    history,
    previousWines,
    cellarIds,
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

  const { message, useQueryExpansion, history, previousWines, cellarIds, date, usedBefore, limit, period } = validated;

  try {
    const result = await aiChat.chat(req.user.id, message, {
      useQueryExpansion,
      history,
      previousWines,
      cellarIds,
    });

    if (result.usage) {
      ChatUsage.findOneAndUpdate(
        { userId: req.user.id, date },
        { $inc: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }
      ).catch(err => console.warn('[chat] token tracking error:', err.message));
    }

    logAudit(req, 'chat.query', { type: 'chat' });
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

  const { message, useQueryExpansion, history, previousWines, cellarIds, date, usedBefore, limit, period } = validated;

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
      cellarIds,
      previousWines,
    }, res);

    // Track token usage (best-effort)
    if (result?.usage) {
      ChatUsage.findOneAndUpdate(
        { userId: req.user.id, date },
        { $inc: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }
      ).catch(err => console.warn('[chat] token tracking error:', err.message));
    }

    logAudit(req, 'chat.query', { type: 'chat' });
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
