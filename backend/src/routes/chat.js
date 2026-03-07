/**
 * POST /api/chat
 *
 * Accepts a natural-language question from the authenticated user and returns
 * an AI-generated wine recommendation drawn exclusively from their cellar.
 *
 * Rate limiting
 * -------------
 * A dedicated per-user limiter (keyed by user ID, not IP) allows 10 questions
 * per hour. This sits on top of the global API limiter in app.js.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const aiChat = require('../services/aiChat');
const aiConfig = require('../config/aiConfig');

const router = express.Router();

// 10 requests per hour per authenticated user
const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Chat rate limit reached — you can ask up to 10 questions per hour.' });
  }
});

// POST /api/chat
router.post('/', requireAuth, chatLimiter, async (req, res) => {
  const cfg = aiConfig.get();
  if (!cfg.chatEnabled) {
    return res.status(503).json({ error: 'AI chat is currently disabled.' });
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'message must not be empty' });
  }
  if (trimmed.length > 1000) {
    return res.status(400).json({ error: 'message must be 1000 characters or fewer' });
  }

  try {
    const result = await aiChat.chat(req.user.id, trimmed);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status === 503) {
      return res.status(503).json({ error: err.message });
    }
    console.error('[chat] Error:', err);
    res.status(500).json({ error: 'Failed to generate recommendation' });
  }
});

module.exports = router;
