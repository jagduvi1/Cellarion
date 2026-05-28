const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { getSecuritySummary } = require('../../services/securityAlertJob');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/security/summary — 24h counts for the SuperAdmin nav badge.
router.get('/summary', async (_req, res) => {
  try {
    res.json(await getSecuritySummary());
  } catch (err) {
    console.error('[admin/security] summary error:', err);
    res.status(500).json({ error: 'Failed to load security summary' });
  }
});

module.exports = router;
