const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { computeGlobalStats } = require('../../services/globalStatsService');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/stats/global
// Returns platform-wide aggregate statistics across all users.
// All figures are anonymised — no PII is included.
//
// Query params:
//   excludeAdmins=true — filter out all users with the 'admin' role from
//                       every per-user statistic. Useful for a customer-only
//                       view that ignores test/admin data.
//   force=true        — bypass the 5-minute in-memory cache and recompute
//                       fresh. Used by the page's Refresh button.
router.get('/global', async (req, res) => {
  try {
    const excludeAdmins = req.query.excludeAdmins === 'true' || req.query.excludeAdmins === '1';
    const force         = req.query.force         === 'true' || req.query.force         === '1';
    const stats = await computeGlobalStats({ excludeAdmins, force });
    res.json(stats);
  } catch (error) {
    console.error('Admin global stats error:', error);
    res.status(500).json({ error: 'Failed to compute global stats' });
  }
});

module.exports = router;
