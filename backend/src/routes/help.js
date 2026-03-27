const express = require('express');
const router = express.Router();
const helpContent = require('../data/helpContent');

/**
 * GET /api/help
 * Public endpoint — no auth required.
 * Returns the complete help content for the Help page.
 */
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(helpContent);
});

module.exports = router;
