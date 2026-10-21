/**
 * GET /api/inventory — the signed-in user's bottles, where each one is, its
 * wine and its drink window, in one compact document for integrations
 * (services/integrationInventory; contract in docs/ha-push-events.md §4).
 *
 * Read-only, scoped to the cellars the user can already open, and reachable
 * with a `read` API token (middleware/apiTokenAuth allowlist). Database reads
 * only — nothing here spends AI money. Home Assistant polls it with the ETag
 * of the copy it holds, so an unchanged poll is one small query and a 304;
 * the per-user limiter below stops a runaway loop from turning the full build
 * into load (304s count too).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { buildInventory, inventoryTag } = require('../services/integrationInventory');
const { attachBottleImageUrls } = require('./cellars');

const router = express.Router();

const inventoryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => String(req.user?.id || ''),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many inventory requests — try again in a few minutes.' });
  },
});

router.get('/', requireAuth, inventoryLimiter, async (req, res) => {
  try {
    // Personal data: never stored by a proxy or an HTTP cache.
    res.setHeader('Cache-Control', 'no-store');
    // Read the tag BEFORE building: a change landing mid-build moves it on,
    // so the next poll rebuilds instead of keeping a copy that misses it.
    const tag = await inventoryTag(req.user.id);
    res.setHeader('ETag', tag);
    if (req.get('If-None-Match') === tag) return res.status(304).end();
    const inventory = await buildInventory(req.user.id, { attachBottleImageUrls });
    res.json(inventory);
  } catch (err) {
    console.error('Inventory error:', err);
    res.status(500).json({ error: 'Failed to build inventory' });
  }
});

module.exports = router;
