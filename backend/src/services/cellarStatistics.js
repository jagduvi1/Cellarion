// What a cellar holds, in figures: the statistics of the cellar page and the
// bottles per maturity stage for the filter's buttons. Both read the active
// bottles with one grouping query and weigh each group by its size, so a
// large cellar costs one pass, not one document per bottle.

const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { NOT_IN_CELLAR_STATUSES } = require('../config/constants');
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
const { getSnapshotsForDates, getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
const { toNormalized, ratingBand } = require('../utils/ratingUtils');

/**
 * How many of a cellar's active bottles are at each maturity stage, with the
 * same classification the list's maturity filter uses, so a button's count
 * is what choosing it shows. Returns { maturity: { declining, late, peak,
 * early, notReady, noProfile }, total }.
 * Caller: GET /api/cellars/:id/maturity-counts.
 */
async function countMaturity(cellarId) {
  // One grouping query, like the statistics: bottles that share what the
  // classification reads — wine, vintage, their own window, and the year
  // an NV window counts from (bottleAnchorYear: bought, else added) — are
  // classified once and weighed by their number.
  const anchorDate = { $convert: { input: { $ifNull: ['$purchaseDate', '$createdAt'] }, to: 'date', onError: null, onNull: null } };
  const groups = await Bottle.aggregate([
    { $match: { cellar: cellarId, status: { $nin: NOT_IN_CELLAR_STATUSES } } },
    {
      $group: {
        _id: {
          wineDefinition: '$wineDefinition',
          vintage: '$vintage',
          drinkFrom: '$drinkFrom',
          drinkTo: '$drinkTo',
          peakFrom: '$peakFrom',
          peakUntil: '$peakUntil',
          anchorYear: { $year: anchorDate },
        },
        count: { $sum: 1 },
      },
    },
  ]).allowDiskUse(true);
  const rows = groups.map((g) => ({
    ...g._id,
    // Mid-year, so the UTC year read back is the year grouped on.
    purchaseDate: g._id.anchorYear != null ? new Date(Date.UTC(g._id.anchorYear, 6, 1)) : null,
    count: g.count,
  }));
  const profileMap = await buildProfileMap(rows);
  const maturity = { declining: 0, late: 0, peak: 0, early: 0, notReady: 0, noProfile: 0 };
  let total = 0;
  for (const b of rows) {
    total += b.count;
    const status = classifyMaturity(b, profileMap);
    if (!status) maturity.noProfile += b.count;
    else if (status === 'not-ready') maturity.notReady += b.count;
    else if (Object.hasOwn(maturity, status)) maturity[status] += b.count;
  }
  return { maturity, total };
}

/**
 * A cellar's statistics over its active bottles: counts, unique wines, value
 * and average price (also converted to `targetCurrency` when one is given,
 * each price at the rate of the day it was set), and the bottles by country,
 * type, vintage and rating band. Returns the statistics object.
 * Caller: GET /api/cellars/:id/statistics.
 */
async function computeCellarStatistics(cellarId, targetCurrency) {
  // Only active bottles count. One grouping query instead of loading every
  // bottle (the cellar page asks on every visit; a 2,800-bottle cellar took
  // ~100–140 ms): bottles that share wine, vintage, rating and scale, price
  // currency and price day count the same way in every figure below, so
  // each group is weighed by its size. A group's price sum converts like
  // its bottles one by one — the conversion is linear and prices are never
  // negative — up to how the sums round: MongoDB adds more precisely than
  // JavaScript, so a total or average that falls on half a cent can round
  // one cent the other way. Groups come in the order of their first bottle,
  // so the maps list their keys in a stable order.
  const priced = { $ne: [{ $ifNull: ['$price', 0] }, 0] };
  const groups = await Bottle.aggregate([
    { $match: { cellar: cellarId, status: { $nin: NOT_IN_CELLAR_STATUSES } } },
    {
      $group: {
        _id: {
          wine: '$wineDefinition',
          vintage: '$vintage',
          rating: '$rating',
          ratingScale: '$ratingScale',
          currency: '$currency',
          // UTC day, as toISOString() gave it; null without a date.
          priceDay: { $dateToString: { format: '%Y-%m-%d', date: '$priceSetAt' } },
        },
        count: { $sum: 1 },
        priceCount: { $sum: { $cond: [priced, 1, 0] } },
        priceSum: { $sum: { $cond: [priced, '$price', 0] } },
        first: { $min: '$_id' },
      },
    },
    { $sort: { first: 1 } },
  ]).allowDiskUse(true);

  // The wines' type and country name, once per wine. A reference to a wine
  // that no longer exists resolves to nothing, as a populate did.
  const wineIds = [...new Set(groups.map(g => g._id.wine).filter(Boolean).map(String))];
  const wineById = new Map((wineIds.length
    ? await WineDefinition.find({ _id: { $in: wineIds } })
      .select('type country')
      .populate('country', 'name')
      .lean()
    : []).map(w => [String(w._id), w]));

  // Batch-load historical rate snapshots for all priceSetAt dates (one DB query)
  let snapshotMap = new Map();
  let todaySnapshot = null;
  if (targetCurrency) {
    const priceDates = [...new Set(
      groups.filter(g => g.priceCount > 0 && g._id.priceDay).map(g => g._id.priceDay)
    )];
    if (priceDates.length > 0) {
      snapshotMap = await getSnapshotsForDates(priceDates);
    }
    // Fetch today's snapshot as fallback for bottles without priceSetAt
    todaySnapshot = await getOrCreateDailySnapshot();
  }

  // Calculate statistics
  const stats = {
    totalBottles: groups.reduce((n, g) => n + g.count, 0),
    // Bottles awaiting a wine request have no wineDefinition — exclude them
    // rather than letting `undefined` count as one extra "unique wine".
    uniqueWines: new Set(
      groups.filter(g => g._id.wine && wineById.has(String(g._id.wine))).map(g => String(g._id.wine))
    ).size,
    totalValue: 0,
    averagePrice: 0,
    convertedTotal: 0,
    convertedAverage: 0,
    convertedCurrency: targetCurrency,
    byCountry: {},
    byType: {},
    byVintage: {},
    byRating: {},
    oldestVintage: null,
    newestVintage: null
  };

  let priceCount = 0;
  let priceSum = 0;
  let convertedSum = 0;
  let convertedCount = 0;
  let oldestYear = Infinity;
  let newestYear = -Infinity;

  for (const g of groups) {
    const wine = g._id.wine ? wineById.get(String(g._id.wine)) : null;

    // Total value calculation
    if (g.priceCount > 0) {
      const currency = g._id.currency || 'USD';
      stats.totalValue += g.priceSum;
      priceSum += g.priceSum;
      priceCount += g.priceCount;

      // Currency-converted total: bottles already in the target currency are
      // used as-is; others are converted using the historical rate from the
      // day the price was entered, falling back to today's rates.
      if (targetCurrency) {
        if (currency === targetCurrency) {
          convertedSum += g.priceSum;
          convertedCount += g.priceCount;
        } else {
          const dateKey = g._id.priceDay || null;
          const rates = (dateKey && snapshotMap.get(dateKey))
            || (todaySnapshot ? todaySnapshot.rates : null);
          const converted = convertCurrency(g.priceSum, currency, targetCurrency, rates);
          if (converted !== null) {
            convertedSum += converted;
            convertedCount += g.priceCount;
          }
        }
      }
    }

    // By country
    const countryName = wine?.country?.name || 'Unknown';
    stats.byCountry[countryName] = (stats.byCountry[countryName] || 0) + g.count;

    // By type
    const type = wine?.type || 'Unknown';
    stats.byType[type] = (stats.byType[type] || 0) + g.count;

    // By vintage
    const vintage = g._id.vintage || 'NV';
    stats.byVintage[vintage] = (stats.byVintage[vintage] || 0) + g.count;

    // Track oldest/newest vintage
    if (vintage !== 'NV') {
      const year = parseInt(vintage);
      if (!isNaN(year)) {
        if (year < oldestYear) oldestYear = year;
        if (year > newestYear) newestYear = year;
      }
    }

    // By rating — normalize to 0-100 and bucket into 5 bands
    if (g._id.rating) {
      const norm = toNormalized(g._id.rating, g._id.ratingScale || '5');
      const band = ratingBand(norm);
      stats.byRating[band] = (stats.byRating[band] || 0) + g.count;
    }
  }

  stats.averagePrice = priceCount > 0 ? priceSum / priceCount : 0;
  stats.convertedTotal = convertedSum;
  stats.convertedAverage = convertedCount > 0 ? convertedSum / convertedCount : 0;
  stats.oldestVintage = oldestYear !== Infinity ? oldestYear : null;
  stats.newestVintage = newestYear !== -Infinity ? newestYear : null;

  // Round values
  stats.totalValue = Math.round(stats.totalValue * 100) / 100;
  stats.averagePrice = Math.round(stats.averagePrice * 100) / 100;
  stats.convertedTotal = Math.round(stats.convertedTotal * 100) / 100;
  stats.convertedAverage = Math.round(stats.convertedAverage * 100) / 100;

  return stats;
}

module.exports = { countMaturity, computeCellarStatistics };
