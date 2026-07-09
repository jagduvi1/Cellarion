/**
 * Cellar Chat routes.
 *
 * POST /api/chat         – ask a question (non-streaming); rate-limited by the daily quota
 * GET  /api/chat/usage   – return current usage + limit for the current user
 *
 * Every user gets the same daily allowance, regardless of plan: a single global
 * limit (aiConfig.chatDailyLimit, default 50/day, -1 = unlimited) over a rolling
 * UTC-day window. Tuned by SuperAdmin via PATCH /api/superadmin/ai/chat-limit.
 */

const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const aiChat = require('../services/aiChat');
const aiConfig = require('../config/aiConfig');
const ChatUsage = require('../models/ChatUsage');
const User = require('../models/User');
const { logAudit } = require('../services/audit');
const rateLimitsConfig = require('../config/rateLimits');

const router = express.Router();

// ── Per-user chat protections ────────────────────────────────────────────────
// The global daily chat limit (aiConfig.chatDailyLimit) is the SPEND cap.
// The burst limit is about BURST behaviour within that cap — it catches
// scripted abuse (5 chats in 5 seconds) that the daily quota can't react to
// fast enough to bound Anthropic spend.

// Burst limit: at most N chats per user per minute. Keyed on req.user.id so
// it survives IP rotation. Per-IP apiLimiter still runs alongside.
const chatBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => rateLimitsConfig.get().chatBurst.max,
  keyGenerator: (req) => String(req.user?.id || ''),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'chat-burst', userId: req.user?.id });
    res.status(429).json({ error: 'Too many chat requests in a short time. Please wait a minute and try again.' });
  },
});

// Returns today's UTC date string 'YYYY-MM-DD'
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Returns a Date set to 90 days from now (retained for usage reporting)
function expiresAt() {
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
}

/**
 * Returns { limit, used, period } for the current user.
 * The same global daily limit applies to everyone (aiConfig.chatDailyLimit;
 * -1 = unlimited) over a rolling UTC-day window.
 */
async function getChatUsage(userId) {
  const limit = aiConfig.get().chatDailyLimit; // -1 = unlimited
  const period = 'daily';

  const docs = await ChatUsage.find({
    userId,
    date: { $gte: todayUTC() },
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

  const limit = cfg.chatDailyLimit; // -1 = unlimited
  const period = 'daily';

  // Debit atomically and gate on the post-increment count. A separate
  // check-then-increment would let N concurrent requests at the limit all
  // pass; here the increment itself is the gate, refunded on overshoot.
  // A concurrent first-of-the-day upsert can lose the unique-index race
  // with E11000 — one retry then hits the existing document.
  let usage;
  try {
    usage = await ChatUsage.findOneAndUpdate(
      { userId: req.user.id, date },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: expiresAt() } },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    usage = await ChatUsage.findOneAndUpdate(
      { userId: req.user.id, date },
      { $inc: { count: 1 } },
      { new: true }
    );
  }
  const usedBefore = usage.count - 1;

  if (limit !== -1 && usage.count > limit) {
    await ChatUsage.findOneAndUpdate(
      { userId: req.user.id, date },
      { $inc: { count: -1 } }
    );
    res.status(429).json({
      error: `You've reached your ${period} limit of ${limit} question${limit === 1 ? '' : 's'}. Try again ${period === 'daily' ? 'tomorrow' : 'in a few days'}.`,
      used: usedBefore,
      limit,
      period,
    });
    return null;
  }

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
    const { limit, used, period } = await getChatUsage(req.user.id);
    res.json({ used, limit, plan: req.user.plan || 'free', period });
  } catch (err) {
    console.error('[chat] usage error:', err);
    res.status(500).json({ error: 'Failed to load usage' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat (non-streaming)
// ---------------------------------------------------------------------------
router.post('/', requireAuth, chatBurstLimiter, asyncHandler(async (req, res) => {
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
}));

module.exports = router;
