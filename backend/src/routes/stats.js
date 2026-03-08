const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const { CONSUMED_STATUSES, WINE_POPULATE } = require('../config/constants');
const { computeOverview, buildEmptyStats } = require('../services/statsService');

const router = express.Router();
router.use(requireAuth);

// GET /api/stats/overview — collection analytics (all authenticated users)
router.get('/overview', async (req, res) => {
  try {
    const dbUser = await User.findById(req.user.id)
      .select('plan planExpiresAt preferences')
      .lean();

    const cellars = await Cellar.find({ user: req.user.id, deletedAt: null }).lean();
    const cellarIds = cellars.map(c => c._id);

    const targetCurrency    = dbUser.preferences?.currency       || 'USD';
    const targetRatingScale = req.user?.preferences?.ratingScale  || '5';

    if (cellarIds.length === 0) {
      return res.json({ stats: buildEmptyStats(targetCurrency) });
    }

    const [activeBottles, consumedBottles] = await Promise.all([
      Bottle.find({ user: req.user.id, cellar: { $in: cellarIds }, status: { $nin: CONSUMED_STATUSES } })
        .populate(WINE_POPULATE)
        .lean(),
      Bottle.find({ user: req.user.id, cellar: { $in: cellarIds }, status: { $in: CONSUMED_STATUSES } })
        .populate({ path: 'wineDefinition', select: 'name producer type' })
        .lean(),
    ]);

    const stats = await computeOverview({ activeBottles, consumedBottles, cellars, targetCurrency, targetRatingScale });
    res.json({ stats });
  } catch (error) {
    console.error('Stats overview error:', error);
    res.status(500).json({ error: 'Failed to load statistics' });
  }
});

module.exports = router;

