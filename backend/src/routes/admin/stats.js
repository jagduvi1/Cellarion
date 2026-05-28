const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { computeGlobalStats } = require('../../services/globalStatsService');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/stats/global
// Returns platform-wide aggregate statistics across all users.
// All figures are anonymised — no PII is included.
router.get('/global', async (_req, res) => {
  try {
    const stats = await computeGlobalStats();
    res.json(stats);
  } catch (error) {
    console.error('Admin global stats error:', error);
    res.status(500).json({ error: 'Failed to compute global stats' });
  }
});

module.exports = router;
