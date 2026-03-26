const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { askGuide } = require('../services/guideAI');

/**
 * POST /api/guide/ask
 * Body: { question: string, currentPage: string }
 * Returns: { message: string, tourId: string|null, suggestions: string[] }
 *
 * Falls back to a simple acknowledgement if the AI service is unavailable
 * (no API key). The frontend handles keyword-based FAQ fallback locally.
 */
router.post('/ask', requireAuth, async (req, res) => {
  const { question, currentPage } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'Question is required' });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: 'Question too long (max 500 characters)' });
  }

  try {
    const result = await askGuide(question.trim(), currentPage || '/');

    if (!result) {
      // AI unavailable — tell frontend to use local fallback
      return res.json({ fallback: true });
    }

    return res.json(result);
  } catch (err) {
    if (err.status === 429) {
      return res.status(429).json({ error: 'Too many requests, please try again in a moment' });
    }
    console.error('[guide] AI error:', err.message);
    // Return fallback flag so frontend uses keyword matching
    return res.json({ fallback: true });
  }
});

module.exports = router;
