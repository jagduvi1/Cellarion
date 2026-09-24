/**
 * GET /api/offline/snapshot — the signed-in user's cellars, bottles and racks
 * in one document, for offline use on their device (#1355; services/offlineSnapshot).
 *
 * Read-only and scoped to cellars the user can already open. The client asks
 * for it on app start, every 15 minutes while open, and a few seconds after
 * its own changes — so the per-user limiter below is generous for that and
 * stops a runaway loop from turning a heavy read into load.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { buildOfflineSnapshot } = require('../services/offlineSnapshot');
const { attachBottleImageUrls } = require('./cellars');

const router = express.Router();

const snapshotLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.user?.id || ''),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many offline refreshes — try again in a few minutes.' });
  },
});

router.get('/snapshot', requireAuth, snapshotLimiter, async (req, res) => {
  try {
    const snapshot = await buildOfflineSnapshot(req.user.id, { attachBottleImageUrls });
    // Personal data: never stored by a proxy or the browser's HTTP cache — the
    // app keeps its own copy, and only when offline mode is on.
    res.setHeader('Cache-Control', 'no-store');
    res.json(snapshot);
  } catch (err) {
    console.error('Offline snapshot error:', err);
    res.status(500).json({ error: 'Failed to build offline snapshot' });
  }
});

module.exports = router;
