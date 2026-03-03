const express = require('express');
const { requireAuth } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');

const router = express.Router();
router.use(requireAuth);

const CONSUMED_STATUSES = ['drank', 'gifted', 'sold', 'other'];

// GET /api/stats/overview — comprehensive collection analytics (premium only)
router.get('/overview', async (req, res) => {
  try {
    // Verify premium plan directly from DB to catch expired plans
    const dbUser = await User.findById(req.user.id)
      .select('plan planExpiresAt preferences')
      .lean();

    const planExpired =
      dbUser.planExpiresAt && Date.now() > new Date(dbUser.planExpiresAt).getTime();

    if (dbUser.plan !== 'premium' || planExpired) {
      return res.status(403).json({ error: 'Premium plan required', code: 'PREMIUM_REQUIRED' });
    }

    const cellars = await Cellar.find({ user: req.user.id, deletedAt: null }).lean();
    const cellarIds = cellars.map(c => c._id);

    if (cellarIds.length === 0) {
      return res.json({ stats: buildEmptyStats(dbUser.preferences?.currency || 'USD') });
    }

    const [activeBottles, consumedBottles] = await Promise.all([
      Bottle.find({
        user: req.user.id,
        cellar: { $in: cellarIds },
        status: { $nin: CONSUMED_STATUSES },
      })
        .populate({ path: 'wineDefinition', populate: ['country', 'region', 'grapes'] })
        .lean(),
      Bottle.find({
        user: req.user.id,
        cellar: { $in: cellarIds },
        status: { $in: CONSUMED_STATUSES },
      }).lean(),
    ]);

    const targetCurrency = dbUser.preferences?.currency || 'USD';
    let todayRates = null;
    try {
      const snap = await getOrCreateDailySnapshot();
      todayRates = snap?.rates || null;
    } catch (_) {
      // rate fetch failure — continue without conversion
    }

    function toTarget(amount, fromCurrency) {
      if (!amount || !fromCurrency) return null;
      if (!todayRates || fromCurrency === targetCurrency) return amount;
      const from = todayRates[fromCurrency];
      const to = todayRates[targetCurrency];
      if (!from || !to) return amount; // fallback: return unconverted
      return (amount / from) * to;
    }

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const msPerDay = 86400000;
    const currentYear = now.getFullYear();

    // Accumulators
    const uniqueWineIds = new Set();
    let totalValue = 0;
    let priceCount = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    let oldestYear = Infinity;
    let newestYear = -Infinity;
    let vintageAgeSum = 0;
    let vintageAgeCount = 0;

    const byType = {};
    const byCountry = {};
    const byRegion = {};
    const byGrape = {};
    const byVintage = {};
    const byRating = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const byBottleSize = {};
    const byPurchaseYear = {};
    const drinkWindow = { overdue: 0, soon: 0, inWindow: 0, notReady: 0, noWindow: 0 };
    const cellarMap = {};
    const topValueArr = [];

    for (const b of activeBottles) {
      const wd = b.wineDefinition;
      if (wd?._id) uniqueWineIds.add(wd._id.toString());

      // Value
      if (b.price) {
        const v = toTarget(b.price, b.currency || 'USD');
        if (v !== null) { totalValue += v; priceCount++; }
      }

      // Rating
      if (b.rating) {
        ratingSum += b.rating;
        ratingCount++;
        byRating[b.rating] = (byRating[b.rating] || 0) + 1;
      }

      // Wine type
      const type = wd?.type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;

      // Country
      const country = wd?.country?.name || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;

      // Region
      if (wd?.region?.name) {
        byRegion[wd.region.name] = (byRegion[wd.region.name] || 0) + 1;
      }

      // Grapes
      for (const g of (wd?.grapes || [])) {
        const gn = g.name || 'Unknown';
        byGrape[gn] = (byGrape[gn] || 0) + 1;
      }

      // Vintage
      const vintage = b.vintage || 'NV';
      byVintage[vintage] = (byVintage[vintage] || 0) + 1;
      if (vintage !== 'NV') {
        const yr = parseInt(vintage, 10);
        if (!isNaN(yr)) {
          if (yr < oldestYear) oldestYear = yr;
          if (yr > newestYear) newestYear = yr;
          vintageAgeSum += (currentYear - yr);
          vintageAgeCount++;
        }
      }

      // Bottle size
      const sz = b.bottleSize || '750ml';
      byBottleSize[sz] = (byBottleSize[sz] || 0) + 1;

      // Purchase year
      if (b.purchaseDate) {
        const py = new Date(b.purchaseDate).getFullYear().toString();
        byPurchaseYear[py] = (byPurchaseYear[py] || 0) + 1;
      }

      // Drink window classification
      const before = b.drinkBefore ? new Date(b.drinkBefore) : null;
      const from = b.drinkFrom ? new Date(b.drinkFrom) : null;
      if (!before && !from) {
        drinkWindow.noWindow++;
      } else if (before) {
        const dl = Math.round((before - now) / msPerDay);
        if (dl < 0) drinkWindow.overdue++;
        else if (dl <= 90) drinkWindow.soon++;
        else if (!from || now >= from) drinkWindow.inWindow++;
        else drinkWindow.notReady++;
      } else {
        if (now < from) drinkWindow.notReady++;
        else drinkWindow.inWindow++;
      }

      // Cellar accumulator
      const cid = b.cellar.toString();
      if (!cellarMap[cid]) {
        const cel = cellars.find(x => x._id.toString() === cid);
        cellarMap[cid] = { name: cel?.name || 'Cellar', count: 0, value: 0, wines: new Set() };
      }
      cellarMap[cid].count++;
      if (b.price) {
        const v = toTarget(b.price, b.currency || 'USD');
        if (v !== null) cellarMap[cid].value += v;
      }
      if (wd?._id) cellarMap[cid].wines.add(wd._id.toString());

      // Top value candidates
      if (b.price && wd) {
        const v = toTarget(b.price, b.currency || 'USD');
        if (v !== null) {
          topValueArr.push({
            name: wd.name || 'Unknown',
            producer: wd.producer || '',
            vintage: b.vintage || 'NV',
            type: wd.type || 'red',
            price: Math.round(v * 100) / 100,
          });
        }
      }
    }

    // Consumption stats
    const consumptionByYear = {};
    const consumptionByReason = { drank: 0, gifted: 0, sold: 0, other: 0 };
    let cRatingSum = 0;
    let cRatingCount = 0;

    for (const b of consumedBottles) {
      const reason = b.consumedReason || 'other';
      consumptionByReason[reason] = (consumptionByReason[reason] || 0) + 1;
      if (b.consumedAt) {
        const yr = new Date(b.consumedAt).getFullYear().toString();
        if (!consumptionByYear[yr]) {
          consumptionByYear[yr] = { drank: 0, gifted: 0, sold: 0, other: 0 };
        }
        consumptionByYear[yr][reason] = (consumptionByYear[yr][reason] || 0) + 1;
      }
      if (b.consumedRating) { cRatingSum += b.consumedRating; cRatingCount++; }
    }

    // Format helpers
    const sortDesc = (obj) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, count }));

    const sortedVintages = Object.entries(byVintage)
      .filter(([y]) => y !== 'NV')
      .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
      .map(([year, count]) => ({ year, count }));
    if (byVintage['NV']) sortedVintages.push({ year: 'NV', count: byVintage['NV'] });

    const cellarBreakdown = Object.values(cellarMap)
      .map(c => ({
        name: c.name,
        bottleCount: c.count,
        value: Math.round(c.value * 100) / 100,
        uniqueWines: c.wines.size,
      }))
      .sort((a, b) => b.bottleCount - a.bottleCount);

    const consumptionByYearArr = Object.entries(consumptionByYear)
      .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
      .map(([year, d]) => ({ year, ...d }));

    const sortedPurchaseYears = Object.entries(byPurchaseYear)
      .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
      .map(([year, count]) => ({ year, count }));

    res.json({
      stats: {
        overview: {
          totalBottles: activeBottles.length,
          totalConsumed: consumedBottles.length,
          uniqueWines: uniqueWineIds.size,
          totalCellars: cellars.length,
          totalCountries: Object.keys(byCountry).length,
          totalGrapes: Object.keys(byGrape).length,
          totalValue: Math.round(totalValue * 100) / 100,
          currency: targetCurrency,
          avgPrice: priceCount > 0 ? Math.round((totalValue / priceCount) * 100) / 100 : 0,
          avgRating: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
          avgConsumedRating:
            cRatingCount > 0 ? Math.round((cRatingSum / cRatingCount) * 10) / 10 : null,
          oldestVintage: oldestYear !== Infinity ? oldestYear : null,
          newestVintage: newestYear !== -Infinity ? newestYear : null,
          avgVintageAge: vintageAgeCount > 0 ? Math.round(vintageAgeSum / vintageAgeCount) : null,
          bottlesDrunk: consumptionByReason.drank,
          bottlesGifted: consumptionByReason.gifted,
          bottlesSold: consumptionByReason.sold,
        },
        byType,
        byCountry: sortDesc(byCountry),
        byRegion: sortDesc(byRegion),
        byGrape: sortDesc(byGrape),
        byVintage: sortedVintages,
        byRating,
        byBottleSize,
        byPurchaseYear: sortedPurchaseYears,
        drinkWindow,
        topValueBottles: topValueArr.sort((a, b) => b.price - a.price).slice(0, 10),
        consumptionByYear: consumptionByYearArr,
        consumptionByReason,
        cellarBreakdown,
      },
    });
  } catch (error) {
    console.error('Stats overview error:', error);
    res.status(500).json({ error: 'Failed to load statistics' });
  }
});

function buildEmptyStats(currency) {
  return {
    overview: {
      totalBottles: 0,
      totalConsumed: 0,
      uniqueWines: 0,
      totalCellars: 0,
      totalCountries: 0,
      totalGrapes: 0,
      totalValue: 0,
      currency,
      avgPrice: 0,
      avgRating: null,
      avgConsumedRating: null,
      oldestVintage: null,
      newestVintage: null,
      avgVintageAge: null,
      bottlesDrunk: 0,
      bottlesGifted: 0,
      bottlesSold: 0,
    },
    byType: {},
    byCountry: [],
    byRegion: [],
    byGrape: [],
    byVintage: [],
    byRating: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    byBottleSize: {},
    byPurchaseYear: [],
    drinkWindow: { overdue: 0, soon: 0, inWindow: 0, notReady: 0, noWindow: 0 },
    topValueBottles: [],
    consumptionByYear: [],
    consumptionByReason: { drank: 0, gifted: 0, sold: 0, other: 0 },
    cellarBreakdown: [],
  };
}

module.exports = router;
