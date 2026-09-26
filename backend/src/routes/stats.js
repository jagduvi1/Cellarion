const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../config/constants');
const { computeOverview, buildEmptyStats } = require('../services/statsService');
const { getDataVersion } = require('../services/dataVersion');
const { getOrCreateDailySnapshot, getSnapshotsForDates, convertCurrency } = require('../utils/exchangeRates');

const router = express.Router();
router.use(requireAuth);

// Server-side cache for the overview. Computing it loads the user's entire
// bottle set. Home Assistant polls it every few minutes and is nudged after
// every change, so the old 2-minute window almost never matched and every poll
// recomputed everything — the #1 database load (scaling audit 2026-09-25).
// Now an entry stays valid while the user's data version (services/dataVersion,
// moved by every audited bottle./cellar. change) is the one it was computed
// at. The max age bounds what the version cannot see: registry edits, curated
// drink windows, exchange rates, jobs and scripts.
const overviewCache = new Map(); // userId -> { at, key, version, stats }
const OVERVIEW_MAX_AGE_MS = 30 * 60 * 1000;
const OVERVIEW_CACHE_MAX_ENTRIES = 5000;

// GET /api/stats/overview — collection analytics (all authenticated users)
router.get('/overview', async (req, res) => {
  try {
    // Read BEFORE anything is loaded: a change landing while this computes
    // moves the version on, so the entry stored below can never outlive it.
    // (The old change signature was taken after the load, so a write in
    // between was cached as current.)
    const version = getDataVersion(req.user.id);

    const dbUser = await User.findById(req.user.id)
      .select('preferences')
      .lean();

    // dbUser can be null: requireAuth only verifies the JWT, so a just-deleted
    // account with a still-valid access token reaches here.
    const targetCurrency    = dbUser?.preferences?.currency      || 'USD';
    const targetRatingScale = dbUser?.preferences?.ratingScale  || '5';

    const cacheKey = `${targetCurrency}:${targetRatingScale}`;
    const cached = overviewCache.get(req.user.id);
    if (cached && cached.key === cacheKey && cached.version === version
      && Date.now() - cached.at < OVERVIEW_MAX_AGE_MS) {
      return res.json({ stats: cached.stats });
    }

    const cellars = await Cellar.find({ user: req.user.id, deletedAt: null }).lean();
    const cellarIds = cellars.map(c => c._id);

    if (cellarIds.length === 0) {
      return res.json({ stats: buildEmptyStats(targetCurrency) });
    }

    const scope = { user: req.user.id, cellar: { $in: cellarIds } };

    const [activeBottles, consumedBottles] = await Promise.all([
      Bottle.find({ ...scope, status: { $nin: CONSUMED_STATUSES } })
        .populate(WINE_POPULATE_LIST)
        .lean(),
      Bottle.find({ ...scope, status: { $in: CONSUMED_STATUSES } })
        .populate(WINE_POPULATE_LIST)
        .lean(),
    ]);

    const stats = await computeOverview({ activeBottles, consumedBottles, cellars, targetCurrency, targetRatingScale });

    if (overviewCache.size >= OVERVIEW_CACHE_MAX_ENTRIES) overviewCache.clear();
    overviewCache.set(req.user.id, { at: Date.now(), key: cacheKey, version, stats });

    res.json({ stats });
  } catch (error) {
    console.error('Stats overview error:', error);
    res.status(500).json({ error: 'Failed to load statistics' });
  }
});

// GET /api/stats/value-history — collection value over time
router.get('/value-history', async (req, res) => {
  try {
    const dbUser = await User.findById(req.user.id)
      .select('preferences')
      .lean();

    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const targetCurrency = dbUser?.preferences?.currency || 'USD';

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

      const conv = (usd) => {
        if (targetCurrency === 'USD' || !rates) return usd;
        const c = convertCurrency(usd, 'USD', targetCurrency, rates);
        return c != null ? c : usd;
      };

      let totalValue = 0;
      let replacementValue = 0;
      let hasReplacement = false; // pre-Phase-1 snapshots have no replacementValue
      const cellarEntries = dateSnapshots.map(s => {
        const value = conv(s.totalValue);
        totalValue += value;
        if (s.replacementValue != null) {
          hasReplacement = true;
          replacementValue += conv(s.replacementValue);
        }
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
        // null (not 0) for dates with no replacement data → the chart draws a
        // gap instead of a misleading zero line.
        replacementValue: hasReplacement ? Math.round(replacementValue * 100) / 100 : null,
        cellars: cellarEntries
      });
    }

    const first = result[0]?.totalValue || 0;
    const latest = result[result.length - 1]?.totalValue || 0;
    const changeAbsolute = Math.round((latest - first) * 100) / 100;
    const changePercent = first > 0 ? Math.round(((latest - first) / first) * 1000) / 10 : 0;

    // Latest replacement total (newest point that has one).
    const latestReplacement = [...result].reverse()
      .find(p => p.replacementValue != null)?.replacementValue ?? null;

    res.json({
      valueHistory: {
        currency: targetCurrency,
        snapshots: result,
        latestTotal: latest,
        latestReplacement,
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

