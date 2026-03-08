const WineVintageProfile = require('../models/WineVintageProfile');
const { getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
const { toNormalized } = require('../utils/ratingUtils');
const { MS_PER_DAY } = require('../config/constants');
const { classifyDrinkWindow } = require('../utils/drinkWindow');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Effective drink window: user-set per-bottle takes priority,
 * sommelier WineVintageProfile (peakFrom/peakUntil years) used as fallback.
 */
function getEffectiveDrinkWindow(bottle, profileMap) {
  if (bottle.drinkFrom || bottle.drinkBefore) {
    return {
      from:   bottle.drinkFrom   ? new Date(bottle.drinkFrom)   : null,
      before: bottle.drinkBefore ? new Date(bottle.drinkBefore) : null,
      source: 'user',
    };
  }
  const wdId    = bottle.wineDefinition?._id?.toString() || bottle.wineDefinition?.toString();
  const vintage = bottle.vintage;
  if (wdId && vintage && vintage !== 'NV') {
    const profile = profileMap.get(`${wdId}:${vintage}`);
    if (profile && profile.status === 'reviewed') {
      const from   = profile.peakFrom  ? new Date(profile.peakFrom,  0, 1)   : null;
      const before = profile.peakUntil ? new Date(profile.peakUntil, 11, 31) : null;
      if (from || before) return { from, before, source: 'somm' };
    }
  }
  return { from: null, before: null, source: 'none' };
}

/** Build and return a WineVintageProfile lookup map for a set of active bottles. */
async function buildProfileMap(activeBottles) {
  const seenPairs = new Set();
  const profileQueries = [];
  for (const b of activeBottles) {
    const wdId = b.wineDefinition?._id?.toString();
    const v    = b.vintage;
    if (wdId && v && v !== 'NV') {
      const key = `${wdId}:${v}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        profileQueries.push({ wineDefinition: wdId, vintage: v });
      }
    }
  }
  const map = new Map();
  if (profileQueries.length === 0) return map;

  const profiles = await WineVintageProfile.find({ $or: profileQueries, status: 'reviewed' }).lean();
  for (const p of profiles) {
    map.set(`${p.wineDefinition.toString()}:${p.vintage}`, p);
  }
  return map;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute the full stats overview given pre-fetched data.
 *
 * @param {object} opts
 * @param {Array}  opts.activeBottles
 * @param {Array}  opts.consumedBottles
 * @param {Array}  opts.cellars          Lean cellar docs the user owns
 * @param {string} opts.targetCurrency
 * @param {string} opts.targetRatingScale
 * @returns {Promise<object>} Full stats payload
 */
async function computeOverview({ activeBottles, consumedBottles, cellars, targetCurrency, targetRatingScale }) {
  const profileMap = await buildProfileMap(activeBottles);

  let todayRates = null;
  try {
    const snap = await getOrCreateDailySnapshot();
    todayRates = snap?.rates || null;
  } catch (_) {}

  const toTarget = (amount, fromCurrency) => {
    if (!amount || !fromCurrency) return null;
    return convertCurrency(amount, fromCurrency, targetCurrency, todayRates) ?? amount;
  };

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const currentYear = now.getFullYear();

  // ── Active-bottle accumulators ────────────────────────────────────────────
  const uniqueWineIds = new Set();
  let totalValue = 0, priceCount = 0;
  let ratingSum  = 0, ratingCount = 0;
  let oldestYear = Infinity, newestYear = -Infinity;
  let vintageAgeSum = 0, vintageAgeCount = 0;

  const byType        = {};
  const byCountry     = {}; // name → { count, code }
  const byRegion      = {};
  const byGrape       = {};
  const byVintage     = {};
  const byRating      = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
  const byBottleSize  = {};
  const byPurchaseYear = {};
  const byProducer    = {};
  const drinkWindow   = { overdue: 0, soon: 0, inWindow: 0, notReady: 0, noWindow: 0 };
  const windowCoverage = { userSet: 0, sommSet: 0, none: 0 };
  const cellarMap     = {};
  const topValueArr   = [];
  const urgencyArr    = [];

  const HEALTH_SCORES = { inWindow: 100, notReady: 85, soon: 60, overdue: 0 };
  let healthScoreSum = 0, healthScoreCount = 0;

  const forecastYears  = Array.from({ length: 11 }, (_, i) => currentYear + i);
  const forecastCounts = Object.fromEntries(forecastYears.map(y => [y, 0]));

  for (const b of activeBottles) {
    const wd = b.wineDefinition;
    if (wd?._id) uniqueWineIds.add(wd._id.toString());

    if (b.price) {
      const v = toTarget(b.price, b.currency || 'USD');
      if (v != null) { totalValue += v; priceCount++; }
    }

    if (b.rating) {
      const normRating = toNormalized(b.rating, b.ratingScale || '5');
      ratingSum += normRating; ratingCount++;
      const band = normRating <= 20 ? '0-20' : normRating <= 40 ? '21-40' : normRating <= 60 ? '41-60' : normRating <= 80 ? '61-80' : '81-100';
      byRating[band] = (byRating[band] || 0) + 1;
    }

    const type = wd?.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;

    const country = wd?.country?.name || 'Unknown';
    if (!byCountry[country]) byCountry[country] = { count: 0, code: wd?.country?.code || null };
    byCountry[country].count++;
    if (wd?.region?.name) byRegion[wd.region.name] = (byRegion[wd.region.name] || 0) + 1;
    for (const g of (wd?.grapes || [])) {
      const gn = g.name || 'Unknown';
      byGrape[gn] = (byGrape[gn] || 0) + 1;
    }

    if (wd?.producer) byProducer[wd.producer] = (byProducer[wd.producer] || 0) + 1;

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

    const sz = b.bottleSize || '750ml';
    byBottleSize[sz] = (byBottleSize[sz] || 0) + 1;

    if (b.purchaseDate) {
      const py = new Date(b.purchaseDate).getFullYear().toString();
      byPurchaseYear[py] = (byPurchaseYear[py] || 0) + 1;
    }

    const { from, before, source } = getEffectiveDrinkWindow(b, profileMap);
    const cls = classifyDrinkWindow(from, before, now);
    drinkWindow[cls]++;

    if (source === 'user')      windowCoverage.userSet++;
    else if (source === 'somm') windowCoverage.sommSet++;
    else                        windowCoverage.none++;

    if (cls !== 'noWindow') {
      healthScoreSum += HEALTH_SCORES[cls] ?? 0;
      healthScoreCount++;
    }

    if (from || before) {
      const fromYear   = from   ? from.getFullYear()   : null;
      const beforeYear = before ? before.getFullYear() : null;
      for (const fy of forecastYears) {
        if ((!fromYear || fy >= fromYear) && (!beforeYear || fy <= beforeYear)) forecastCounts[fy]++;
      }
    }

    if (cls === 'overdue' || cls === 'soon') {
      urgencyArr.push({
        name:          wd?.name      || 'Unknown',
        producer:      wd?.producer  || '',
        vintage:       b.vintage     || 'NV',
        type:          wd?.type      || 'unknown',
        price:         b.price ? Math.round((toTarget(b.price, b.currency || 'USD') ?? 0) * 100) / 100 : null,
        daysRemaining: before ? Math.round((before - now) / MS_PER_DAY) : null,
        status:        cls,
        source,
      });
    }

    const cid = b.cellar.toString();
    if (!cellarMap[cid]) {
      const cel = cellars.find(x => x._id.toString() === cid);
      cellarMap[cid] = { name: cel?.name || 'Cellar', count: 0, value: 0, wines: new Set() };
    }
    cellarMap[cid].count++;
    if (b.price) {
      const v = toTarget(b.price, b.currency || 'USD');
      if (v != null) cellarMap[cid].value += v;
    }
    if (wd?._id) cellarMap[cid].wines.add(wd._id.toString());

    if (b.price && wd) {
      const v = toTarget(b.price, b.currency || 'USD');
      if (v != null) topValueArr.push({ name: wd.name || 'Unknown', producer: wd.producer || '', vintage: b.vintage || 'NV', type: wd.type || 'red', price: Math.round(v * 100) / 100 });
    }
  }

  // ── Consumption-bottle accumulators ───────────────────────────────────────
  const consumptionByYear   = {};
  const consumptionByReason = { drank: 0, gifted: 0, sold: 0, other: 0 };
  let cRatingSum = 0, cRatingCount = 0;
  const outputByYear = {};

  const HOLD_BUCKETS = ['<1yr', '1–2yr', '2–5yr', '5–10yr', '10+yr'];
  const holdingBuckets = Object.fromEntries(HOLD_BUCKETS.map(b => [b, { count: 0, ratingSum: 0, ratingCount: 0 }]));
  const jpdByType = {};
  const regretItems = [];

  for (const b of consumedBottles) {
    const reason = b.consumedReason || 'other';
    consumptionByReason[reason] = (consumptionByReason[reason] || 0) + 1;

    const consumedYear = b.consumedAt ? new Date(b.consumedAt).getFullYear().toString() : null;
    if (consumedYear) {
      if (!consumptionByYear[consumedYear]) consumptionByYear[consumedYear] = { drank: 0, gifted: 0, sold: 0, other: 0 };
      consumptionByYear[consumedYear][reason]++;
      outputByYear[consumedYear] = (outputByYear[consumedYear] || 0) + 1;
    }

    if (b.consumedRating) {
      const normCR = toNormalized(b.consumedRating, b.consumedRatingScale || '5');
      cRatingSum += normCR; cRatingCount++;
    }

    const anchor = b.purchaseDate || b.createdAt;
    if (b.consumedAt && anchor) {
      const daysHeld = (new Date(b.consumedAt) - new Date(anchor)) / MS_PER_DAY;
      const bucket = daysHeld < 365 ? '<1yr' : daysHeld < 730 ? '1–2yr' : daysHeld < 1825 ? '2–5yr' : daysHeld < 3650 ? '5–10yr' : '10+yr';
      holdingBuckets[bucket].count++;
      if (b.consumedRating) {
        const normCR = toNormalized(b.consumedRating, b.consumedRatingScale || '5');
        holdingBuckets[bucket].ratingSum   += normCR;
        holdingBuckets[bucket].ratingCount++;
      }
    }

    if (reason === 'drank' && b.consumedRating && b.price) {
      const type     = b.wineDefinition?.type || 'unknown';
      const priceCvt = toTarget(b.price, b.currency || 'USD');
      if (priceCvt && priceCvt > 0) {
        const normCR = toNormalized(b.consumedRating, b.consumedRatingScale || '5');
        if (!jpdByType[type]) jpdByType[type] = { ratingSum: 0, ratingCount: 0, priceSum: 0, priceCount: 0 };
        jpdByType[type].ratingSum   += normCR;
        jpdByType[type].ratingCount++;
        jpdByType[type].priceSum    += priceCvt;
        jpdByType[type].priceCount++;
      }
    }

    if (b.rating && b.consumedRating) {
      const wd = b.wineDefinition;
      regretItems.push({
        name:           wd?.name  || 'Unknown',
        vintage:        b.vintage || 'NV',
        type:           wd?.type  || 'unknown',
        rating:         toNormalized(b.rating,         b.ratingScale         || '5'),
        consumedRating: toNormalized(b.consumedRating, b.consumedRatingScale || '5'),
        delta:          toNormalized(b.consumedRating, b.consumedRatingScale || '5') - toNormalized(b.rating, b.ratingScale || '5'),
      });
    }
  }

  // ── Derived stats ─────────────────────────────────────────────────────────
  const healthScore = healthScoreCount > 0 ? Math.round(healthScoreSum / healthScoreCount) : null;
  const healthGrade = healthScore === null ? null : healthScore >= 85 ? 'A' : healthScore >= 70 ? 'B' : healthScore >= 55 ? 'C' : healthScore >= 40 ? 'D' : 'F';

  const bottlesWithWindow = drinkWindow.overdue + drinkWindow.soon + drinkWindow.inWindow + drinkWindow.notReady;
  const regretIndex = bottlesWithWindow > 0 ? Math.round((drinkWindow.overdue / bottlesWithWindow) * 100) : 0;

  const drinkWindowForecast = forecastYears.map(y => ({ year: y, count: forecastCounts[y] || 0, isCurrent: y === currentYear }));

  urgencyArr.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'overdue' ? -1 : 1;
    const aDays = a.daysRemaining ?? Infinity, bDays = b.daysRemaining ?? Infinity;
    if (aDays !== bDays) return aDays - bDays;
    return (b.price || 0) - (a.price || 0);
  });

  const holdingTime = HOLD_BUCKETS.map(bucket => ({
    bucket,
    count: holdingBuckets[bucket].count,
    avgConsumedRating: holdingBuckets[bucket].ratingCount > 0
      ? Math.round((holdingBuckets[bucket].ratingSum / holdingBuckets[bucket].ratingCount) * 10) / 10
      : null,
  }));

  const joyPerDollar = Object.entries(jpdByType)
    .filter(([, d]) => d.ratingCount > 0 && d.priceCount > 0)
    .map(([type, d]) => ({
      type,
      avgRating: Math.round((d.ratingSum / d.ratingCount) * 10) / 10,
      avgPrice:  Math.round((d.priceSum  / d.priceCount)  * 100) / 100,
      score:     Math.round(((d.ratingSum / d.ratingCount) / (d.priceSum / d.priceCount)) * 1000 * 10) / 10,
      count:     d.ratingCount,
    }))
    .sort((a, b) => b.score - a.score);

  const regretSignal = {
    surprises:      regretItems.filter(r => r.delta >= 1).sort((a, b) => b.delta - a.delta).slice(0, 5),
    disappointments: regretItems.filter(r => r.delta <= -1).sort((a, b) => a.delta - b.delta).slice(0, 5),
    avgDelta: regretItems.length > 0 ? Math.round((regretItems.reduce((s, r) => s + r.delta, 0) / regretItems.length) * 10) / 10 : null,
    count: regretItems.length,
  };

  const allDataYears = [...new Set([...Object.keys(byPurchaseYear), ...Object.keys(outputByYear)])].map(Number).sort((a, b) => b - a).slice(0, 5);
  const recentIntake = allDataYears.length > 0 ? allDataYears.reduce((s, y) => s + (byPurchaseYear[y.toString()] || 0), 0) / allDataYears.length : 0;
  const recentOutput = allDataYears.length > 0 ? allDataYears.reduce((s, y) => s + (outputByYear[y.toString()] || 0), 0) / allDataYears.length : 0;
  const pace = {
    avgIntakePerYear: Math.round(recentIntake * 10) / 10,
    avgOutputPerYear: Math.round(recentOutput * 10) / 10,
    netPerYear:       Math.round((recentIntake - recentOutput) * 10) / 10,
    runway: recentOutput > 0 ? Math.round(activeBottles.length / recentOutput) : null,
  };

  const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, count]) => ({ name, count }));

  return {
    overview: {
      totalBottles:      activeBottles.length,
      totalConsumed:     consumedBottles.length,
      uniqueWines:       uniqueWineIds.size,
      totalCellars:      cellars.length,
      totalCountries:    Object.keys(byCountry).length,
      totalGrapes:       Object.keys(byGrape).length,
      totalValue:        Math.round(totalValue * 100) / 100,
      currency:          targetCurrency,
      avgPrice:          priceCount > 0 ? Math.round((totalValue / priceCount) * 100) / 100 : 0,
      avgRating:         ratingCount  > 0 ? Math.round((ratingSum  / ratingCount)  * 10) / 10 : null,
      avgConsumedRating: cRatingCount > 0 ? Math.round((cRatingSum / cRatingCount) * 10) / 10 : null,
      targetRatingScale,
      oldestVintage:     oldestYear !== Infinity  ? oldestYear  : null,
      newestVintage:     newestYear !== -Infinity ? newestYear  : null,
      avgVintageAge:     vintageAgeCount > 0 ? Math.round(vintageAgeSum / vintageAgeCount) : null,
      bottlesDrunk:      consumptionByReason.drank,
      bottlesGifted:     consumptionByReason.gifted,
      bottlesSold:       consumptionByReason.sold,
      healthScore,
      healthGrade,
      regretIndex,
    },
    byType,
    byCountry: Object.entries(byCountry).sort((a, b) => b[1].count - a[1].count).map(([name, d]) => ({ name, count: d.count, code: d.code })),
    byRegion:  sortDesc(byRegion),
    byGrape:   sortDesc(byGrape),
    byVintage: [
      ...Object.entries(byVintage).filter(([y]) => y !== 'NV').sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10)).map(([year, count]) => ({ year, count })),
      ...(byVintage['NV'] ? [{ year: 'NV', count: byVintage['NV'] }] : []),
    ],
    byRating,
    byBottleSize,
    byPurchaseYear: Object.entries(byPurchaseYear).sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10)).map(([year, count]) => ({ year, count })),
    drinkWindow,
    windowCoverage,
    topValueBottles:  topValueArr.sort((a, b) => b.price - a.price).slice(0, 10),
    consumptionByYear: Object.entries(consumptionByYear).sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10)).map(([year, d]) => ({ year, ...d })),
    consumptionByReason,
    cellarBreakdown: Object.values(cellarMap).map(c => ({ name: c.name, bottleCount: c.count, value: Math.round(c.value * 100) / 100, uniqueWines: c.wines.size })).sort((a, b) => b.bottleCount - a.bottleCount),
    drinkWindowForecast,
    urgencyLadder: urgencyArr.slice(0, 10),
    holdingTime,
    joyPerDollar,
    regretSignal,
    pace,
    topProducers: Object.entries(byProducer).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
  };
}

function buildEmptyStats(currency) {
  return {
    overview: {
      totalBottles: 0, totalConsumed: 0, uniqueWines: 0, totalCellars: 0,
      totalCountries: 0, totalGrapes: 0, totalValue: 0, currency,
      avgPrice: 0, avgRating: null, avgConsumedRating: null,
      oldestVintage: null, newestVintage: null, avgVintageAge: null,
      bottlesDrunk: 0, bottlesGifted: 0, bottlesSold: 0,
      healthScore: null, healthGrade: null, regretIndex: 0,
    },
    byType: {}, byCountry: [], byRegion: [], byGrape: [],
    byVintage: [], byRating: { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 },
    byBottleSize: {}, byPurchaseYear: [],
    drinkWindow:   { overdue: 0, soon: 0, inWindow: 0, notReady: 0, noWindow: 0 },
    windowCoverage: { userSet: 0, sommSet: 0, none: 0 },
    topValueBottles: [], consumptionByYear: [],
    consumptionByReason: { drank: 0, gifted: 0, sold: 0, other: 0 },
    cellarBreakdown: [],
    drinkWindowForecast: [], urgencyLadder: [], holdingTime: [],
    joyPerDollar: [],
    regretSignal: { surprises: [], disappointments: [], avgDelta: null, count: 0 },
    pace: { avgIntakePerYear: 0, avgOutputPerYear: 0, netPerYear: 0, runway: null },
    topProducers: [],
  };
}

module.exports = { computeOverview, buildEmptyStats };
