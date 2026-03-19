const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const { CONSUMED_STATUSES, WINE_POPULATE } = require('../config/constants');
const { computeOverview, buildEmptyStats } = require('../services/statsService');
const { getOrCreateDailySnapshot, getSnapshotsForDates, convertCurrency } = require('../utils/exchangeRates');

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

// GET /api/stats/value-history — collection value over time (premium only)
router.get('/value-history', async (req, res) => {
  try {
    const dbUser = await User.findById(req.user.id)
      .select('plan planExpiresAt preferences')
      .lean();

    const planExpired = dbUser.planExpiresAt && Date.now() > new Date(dbUser.planExpiresAt).getTime();
    const effectivePlan = planExpired ? 'free' : (dbUser.plan || 'free');
    if (effectivePlan !== 'premium') {
      return res.status(403).json({ error: 'Premium plan required' });
    }

    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const targetCurrency = dbUser.preferences?.currency || 'USD';

    const cellars = await Cellar.find({ user: req.user.id, deletedAt: null }).select('_id name').lean();
    const cellarIds = cellars.map(c => c._id);
    const cellarNames = Object.fromEntries(cellars.map(c => [c._id.toString(), c.name]));

    if (cellarIds.length === 0) {
      return res.json({ valueHistory: { currency: targetCurrency, snapshots: [], latestTotal: 0, changePercent: 0, changeAbsolute: 0 } });
    }

    const snapshots = await CellarValueSnapshot.find({
      user: req.user.id,
      cellar: { $in: cellarIds },
      date: { $gte: cutoffDate }
    }).sort({ date: 1 }).lean();

    if (snapshots.length === 0) {
      return res.json({ valueHistory: { currency: targetCurrency, snapshots: [], latestTotal: 0, changePercent: 0, changeAbsolute: 0 } });
    }

    // Gather unique dates and fetch exchange rate snapshots
    const uniqueDates = [...new Set(snapshots.map(s => s.date))];
    const rateMap = await getSnapshotsForDates(uniqueDates);

    // Fallback to today's rates if some dates don't have snapshots
    let fallbackRates = null;
    if (targetCurrency !== 'USD') {
      try {
        const todaySnap = await getOrCreateDailySnapshot();
        fallbackRates = todaySnap?.rates || null;
      } catch (_) {}
    }

    // Group snapshots by date
    const byDate = {};
    for (const s of snapshots) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }

    const result = [];
    for (const date of uniqueDates.sort()) {
      const dateSnapshots = byDate[date] || [];
      const rates = rateMap.get(date) || fallbackRates;

      let totalValue = 0;
      const cellarEntries = dateSnapshots.map(s => {
        let value = s.totalValue;
        if (targetCurrency !== 'USD' && rates) {
          const converted = convertCurrency(s.totalValue, 'USD', targetCurrency, rates);
          if (converted != null) value = converted;
        }
        totalValue += value;
        return {
          cellarId: s.cellar.toString(),
          name: cellarNames[s.cellar.toString()] || 'Cellar',
          value: Math.round(value * 100) / 100,
          bottleCount: s.bottleCount
        };
      });

      result.push({
        date,
        totalValue: Math.round(totalValue * 100) / 100,
        cellars: cellarEntries
      });
    }

    const first = result[0]?.totalValue || 0;
    const latest = result[result.length - 1]?.totalValue || 0;
    const changeAbsolute = Math.round((latest - first) * 100) / 100;
    const changePercent = first > 0 ? Math.round(((latest - first) / first) * 1000) / 10 : 0;

    res.json({
      valueHistory: {
        currency: targetCurrency,
        snapshots: result,
        latestTotal: latest,
        changePercent,
        changeAbsolute
      }
    });
  } catch (error) {
    console.error('Value history error:', error);
    res.status(500).json({ error: 'Failed to load value history' });
  }
});

module.exports = router;

