/**
 * Cellar Chat routes.
 *
 * POST /api/chat         – ask a question (non-streaming); rate-limited by the daily quota
 * POST /api/chat/stream  – ask a question (streaming SSE); same rate limiting
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
const { ConcurrentStreamLimiter } = require('../utils/concurrentStreams');

const router = express.Router();

// ── Per-user chat protections ────────────────────────────────────────────────
// The global daily chat limit (aiConfig.chatDailyLimit) is the SPEND cap.
// These two limits are about BURST behaviour within that cap — they catch
// scripted abuse (5 chats in 5 seconds; 50 concurrent SSE streams) that the
// daily quota can't react to fast enough to bound Anthropic spend.

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

// Concurrent-stream cap: at most N simultaneous SSE streams per user.
// Reads max() from config on each acquire so admins can tune live.
const streamLimiter = new ConcurrentStreamLimiter(
  () => rateLimitsConfig.get().chatConcurrentStreams.max
);

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

// ---------------------------------------------------------------------------
// POST /api/chat/stream (streaming SSE)
// ---------------------------------------------------------------------------
router.post('/stream', requireAuth, chatBurstLimiter, asyncHandler(async (req, res) => {
  // ── Concurrency cap ────────────────────────────────────────────────────
  // Reserve a slot BEFORE doing any DB / Anthropic work, so a user at the
  // cap gets a clean 429 instead of triggering a refunded debit. Released
  // in the finally below regardless of success/error/timeout.
  const streamSlotId = streamLimiter.tryAcquire(req.user.id);
  if (!streamSlotId) {
    logAudit(req, 'system.rate_limit_exceeded', {}, {
      limiter: 'chat-concurrent-streams',
      userId: req.user.id,
      current: streamLimiter.count(req.user.id),
    });
    return res.status(429).json({
      error: `You already have ${streamLimiter.count(req.user.id)} chats running. Please wait for one to finish.`,
    });
  }

  // SSE max-duration timer — bounds worst-case Anthropic spend if a tool-use
  // loop runs away with a stuck client. Cleared on normal completion, on
  // client disconnect, and on any error path via the finally below.
  //
  // Hardcoded 90s — not admin-tunable. This is a system safety bound on
  // Anthropic spend, not a tuning knob; making it editable would create a
  // req.body → setTimeout taint path (CodeQL js/resource-exhaustion).
  const SSE_MAX_MS = 90_000;
  let timeoutFired = false;
  const sseTimer = setTimeout(() => {
    timeoutFired = true;
    if (!res.writableEnded) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream timed out' })}\n\n`); } catch (_) {}
      try { res.end(); } catch (_) {}
    }
    logAudit(req, 'chat.stream.timeout', { type: 'chat' }, { userId: req.user.id, ms: SSE_MAX_MS });
  }, SSE_MAX_MS);

  try {
    const validated = await validateAndCheckLimit(req, res);
    if (!validated) return;  // validate already sent the response; finally below cleans up

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

      // If headers already flushed and we haven't timed out, send error as SSE event
      if (!res.writableEnded && !timeoutFired) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message || 'Failed to generate recommendation' })}\n\n`);
        res.end();
      }
    }
  } finally {
    clearTimeout(sseTimer);
    streamLimiter.release(req.user.id, streamSlotId);
  }
}));

module.exports = router;
