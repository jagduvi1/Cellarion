const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineRequest = require('../models/WineRequest');
const BottleImage = require('../models/BottleImage');
const Rack = require('../models/Rack');

// ── Helpers ──────────────────────────────────────────────────────────────────

const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const pct = (count, total) => total > 0 ? round((count / total) * 100, 1) : 0;

const safeAggregate = async (model, pipeline) => {
  try { return await model.aggregate(pipeline); }
  catch (err) {
    console.error(`Aggregate failed on ${model.modelName}:`, err.message);
    return [];
  }
};

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Compute platform-wide aggregate statistics across all users.
 * Returns an anonymised payload safe to surface to admins.
 *
 * @param {object}  [options]
 * @param {boolean} [options.excludeAdmins=false]
 *        When true, all per-user data (bottles, cellars, user counts, plans,
 *        engagement, image uploads, wine requests) is filtered to exclude any
 *        user with the 'admin' role — useful for getting a customer-only view
 *        of the platform without admin/test data polluting the numbers.
 * @returns {Promise<object>}
 */
async function computeGlobalStats({ excludeAdmins = false } = {}) {
  const currentYear = new Date().getFullYear();
  const since30 = new Date(Date.now() - 30 * 86400000);
  const since90 = new Date(Date.now() - 90 * 86400000);
  const since24h = new Date(Date.now() - 86400000);
  const since7d  = new Date(Date.now() - 7 * 86400000);

  // ── Admin-exclusion filters ─────────────────────────────────────────────
  let adminIds = [];
  if (excludeAdmins) {
    const admins = await User.find({ roles: 'admin' }).select('_id').lean();
    adminIds = admins.map(a => a._id);
  }
  const userMatch     = excludeAdmins ? { roles: { $nin: ['admin'] } } : {};
  const bottleMatch   = excludeAdmins ? { user: { $nin: adminIds } }   : {};
  const cellarMatch   = excludeAdmins ? { user: { $nin: adminIds } }   : {};
  const imageMatch    = excludeAdmins ? { uploadedBy: { $nin: adminIds } } : {};
  const requestMatch  = excludeAdmins ? { user: { $nin: adminIds } }       : {};

  // ── Overview ────────────────────────────────────────────────────────────
  const [
    totalUsers,
    totalCellars,
    totalBottles,
    activeBottles,
    consumedBottles,
    drankBottles,
    giftedBottles,
    soldBottles,
    usersWithBottles,
    newUsers30,
    newUsers90,
    bottlesAdded30,
    bottlesAdded90,
    bottlesConsumed30,
    bottlesConsumed90,
  ] = await Promise.all([
    User.countDocuments(userMatch),
    Cellar.countDocuments(cellarMatch),
    Bottle.countDocuments(bottleMatch),
    Bottle.countDocuments({ ...bottleMatch, status: 'active' }),
    Bottle.countDocuments({ ...bottleMatch, status: { $ne: 'active' } }),
    Bottle.countDocuments({ ...bottleMatch, status: 'drank' }),
    Bottle.countDocuments({ ...bottleMatch, status: 'gifted' }),
    Bottle.countDocuments({ ...bottleMatch, status: 'sold' }),
    Bottle.distinct('user', bottleMatch).then(ids => ids.length),
    User.countDocuments({ ...userMatch, createdAt: { $gte: since30 } }),
    User.countDocuments({ ...userMatch, createdAt: { $gte: since90 } }),
    Bottle.countDocuments({ ...bottleMatch, createdAt: { $gte: since30 } }),
    Bottle.countDocuments({ ...bottleMatch, createdAt: { $gte: since90 } }),
    Bottle.countDocuments({ ...bottleMatch, consumedAt: { $gte: since30 } }),
    Bottle.countDocuments({ ...bottleMatch, consumedAt: { $gte: since90 } }),
  ]);

  // ── Country / region / grape / producer breakdowns ──────────────────────
  const topCountries = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $lookup: { from: 'countries', localField: 'wd.country', foreignField: '_id', as: 'country' } },
    { $unwind: { path: '$country', preserveNullAndEmptyArrays: true } },
    { $group: { _id: { name: '$country.name', code: '$country.code' }, count: { $sum: 1 } } },
    { $match: { '_id.name': { $ne: null } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: '$_id.name', code: '$_id.code', count: 1 } },
  ]);

  const topRegions = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $lookup: { from: 'regions', localField: 'wd.region', foreignField: '_id', as: 'region' } },
    { $unwind: { path: '$region', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$region.name', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: '$_id', count: 1 } },
  ]);

  const topGrapes = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $unwind: { path: '$wd.grapes', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'grapes', localField: 'wd.grapes', foreignField: '_id', as: 'grape' } },
    { $unwind: { path: '$grape', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$grape.name', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: '$_id', count: 1 } },
  ]);

  const topProducers = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $group: { _id: '$wd.producer', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: '$_id', count: 1 } },
  ]);

  // ── Wine types ──────────────────────────────────────────────────────────
  const byType = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $group: { _id: '$wd.type', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, type: '$_id', count: 1 } },
  ]);

  // ── Vintage stats ───────────────────────────────────────────────────────
  const vintageRaw = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', vintage: { $nin: ['NV', null, ''] } } },
    { $addFields: { yr: { $convert: { input: '$vintage', to: 'int', onError: null, onNull: null } } } },
    { $match: { yr: { $gt: 1800, $lte: currentYear } } },
    { $group: {
      _id: null,
      avgAge:  { $avg: { $subtract: [currentYear, '$yr'] } },
      oldest:  { $min: '$yr' },
      newest:  { $max: '$yr' },
      count:   { $sum: 1 },
    }},
  ]);
  const vintage = vintageRaw[0] || { avgAge: null, oldest: null, newest: null, count: 0 };

  const byDecade = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', vintage: { $nin: ['NV', null, ''] } } },
    { $addFields: { yr: { $convert: { input: '$vintage', to: 'int', onError: null, onNull: null } } } },
    { $match: { yr: { $gt: 1800, $lte: currentYear } } },
    { $addFields: { decade: { $multiply: [{ $floor: { $divide: ['$yr', 10] } }, 10] } } },
    { $group: { _id: '$decade', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, decade: '$_id', count: 1 } },
  ]);

  // ── Price (grouped by currency — avoids cross-rate noise) ───────────────
  const priceByCurrency = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', price: { $gt: 0 } } },
    { $group: {
      _id: '$currency',
      count:      { $sum: 1 },
      avgPrice:   { $avg: '$price' },
      totalValue: { $sum: '$price' },
      maxPrice:   { $max: '$price' },
    }},
    { $sort: { count: -1 } },
    { $project: { _id: 0, currency: '$_id', count: 1, avgPrice: { $round: ['$avgPrice', 2] }, totalValue: { $round: ['$totalValue', 2] }, maxPrice: 1 } },
  ]);

  // ── Holding time (purchase → consumption) ───────────────────────────────
  const holdingRaw = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: { $ne: 'active' }, consumedAt: { $ne: null }, purchaseDate: { $ne: null } } },
    { $addFields: { daysHeld: { $divide: [{ $subtract: ['$consumedAt', '$purchaseDate'] }, 86400000] } } },
    { $bucket: {
      groupBy: '$daysHeld',
      boundaries: [0, 365, 730, 1825, 3650, 100000],
      default: 'over',
      output: { count: { $sum: 1 } },
    }},
  ]);
  const holdingLabels = ['<1yr', '1–2yr', '2–5yr', '5–10yr', '10+yr', 'over'];
  const totalHeld = holdingRaw.reduce((s, h) => s + h.count, 0);
  const holdingTime = holdingRaw.map((h, i) => ({
    bucket: holdingLabels[i] || String(h._id),
    count:  h.count,
    pct:    pct(h.count, totalHeld),
  }));

  // ── Bottle-size distribution ────────────────────────────────────────────
  const byBottleSize = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active' } },
    { $group: { _id: '$bottleSize', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, size: '$_id', count: 1 } },
  ]);

  // ── Cellar-size distribution ────────────────────────────────────────────
  const bottlesPerCellar = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active' } },
    { $group: { _id: '$cellar', count: { $sum: 1 } } },
    { $bucket: {
      groupBy: '$count',
      boundaries: [1, 10, 25, 50, 100, 250, 500, 100000],
      default: 'other',
      output: { count: { $sum: 1 } },
    }},
  ]);
  const cellarSizeLabels = ['1–9', '10–24', '25–49', '50–99', '100–249', '250–499', '500+'];
  const cellarSizeDistribution = bottlesPerCellar.map((b, i) => ({
    bucket: cellarSizeLabels[i] || 'other',
    cellars: b.count,
  }));

  // ── Top wine definitions (most-collected wines) ─────────────────────────
  const topWines = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
    { $lookup: { from: 'winedefinitions', localField: '_id', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $project: { _id: 0, name: '$wd.name', producer: '$wd.producer', type: '$wd.type', count: 1 } },
  ]);

  // ── Engagement (active users 24h / 7d / 30d / 90d) ──────────────────────
  // "Active" = added a bottle or consumed a bottle within the window.
  const engagementWindow = async (since) => {
    const r = await safeAggregate(Bottle, [
      { $match: { ...bottleMatch, $or: [
        { createdAt:  { $gte: since } },
        { consumedAt: { $gte: since } },
      ]}},
      { $group: { _id: '$user' } },
      { $count: 'count' },
    ]);
    return r[0]?.count || 0;
  };

  const [activeUsers24h, activeUsers7d, activeUsers30d, activeUsers90d] = await Promise.all([
    engagementWindow(since24h),
    engagementWindow(since7d),
    engagementWindow(since30),
    engagementWindow(since90),
  ]);

  // ── Plans / subscriptions ───────────────────────────────────────────────
  const planDistribution = await safeAggregate(User, [
    { $match: userMatch },
    { $group: { _id: '$plan', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, plan: '$_id', count: 1 } },
  ]);

  const in7d  = new Date(Date.now() + 7 * 86400000);
  const in30d = new Date(Date.now() + 30 * 86400000);
  const [paidUsers, expiringIn7d, expiringIn30d, trialEligibleUsers, withStripeCustomer] = await Promise.all([
    User.countDocuments({ ...userMatch, plan: { $ne: 'free' } }),
    User.countDocuments({ ...userMatch, planExpiresAt: { $gte: new Date(), $lte: in7d } }),
    User.countDocuments({ ...userMatch, planExpiresAt: { $gte: new Date(), $lte: in30d } }),
    User.countDocuments({ ...userMatch, trialEligible: true, plan: 'free' }),
    User.countDocuments({ ...userMatch, stripeCustomerId: { $ne: null } }),
  ]);

  // ── Maturity (drink-window phase distribution) ──────────────────────────
  // Joins active bottles to reviewed WineVintageProfile and classifies each
  // bottle against the current year. Bottles without a reviewed profile, or
  // with NV vintage, fall into 'noProfile'.
  const maturityRaw = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active' } },
    { $lookup: {
      from: 'winevintageprofiles',
      let: { wdId: '$wineDefinition', v: '$vintage' },
      pipeline: [
        { $match: { $expr: { $and: [
          { $eq: ['$wineDefinition', '$$wdId'] },
          { $eq: ['$vintage', '$$v'] },
          { $eq: ['$status', 'reviewed'] },
        ]}}},
        { $limit: 1 },
      ],
      as: 'profile',
    }},
    { $unwind: { path: '$profile', preserveNullAndEmptyArrays: true } },
    { $addFields: {
      maturity: {
        $cond: {
          if: { $eq: [{ $ifNull: ['$profile', null] }, null] },
          then: 'noProfile',
          else: {
            $switch: {
              branches: [
                { case: { $and: [
                  { $ne: ['$profile.earlyFrom', null] },
                  { $lt: [currentYear, '$profile.earlyFrom'] },
                ]}, then: 'notReady' },
                { case: { $and: [
                  { $eq: ['$profile.earlyFrom', null] },
                  { $ne: ['$profile.peakFrom', null] },
                  { $lt: [currentYear, '$profile.peakFrom'] },
                ]}, then: 'notReady' },
                { case: { $and: [
                  { $ne: ['$profile.earlyUntil', null] },
                  { $lte: [currentYear, '$profile.earlyUntil'] },
                ]}, then: 'early' },
                { case: { $and: [
                  { $ne: ['$profile.peakFrom', null] },
                  { $lt: [currentYear, '$profile.peakFrom'] },
                ]}, then: 'early' },
                { case: { $and: [
                  { $ne: ['$profile.peakUntil', null] },
                  { $lte: [currentYear, '$profile.peakUntil'] },
                ]}, then: 'peak' },
                { case: { $and: [
                  { $ne: ['$profile.lateFrom', null] },
                  { $lt: [currentYear, '$profile.lateFrom'] },
                ]}, then: 'peak' },
                { case: { $and: [
                  { $ne: ['$profile.lateUntil', null] },
                  { $lte: [currentYear, '$profile.lateUntil'] },
                ]}, then: 'late' },
                { case: { $and: [
                  { $ne: ['$profile.lateUntil', null] },
                  { $gt: [currentYear, '$profile.lateUntil'] },
                ]}, then: 'declining' },
                { case: { $and: [
                  { $ne: ['$profile.peakUntil', null] },
                  { $gt: [currentYear, '$profile.peakUntil'] },
                  { $eq: ['$profile.lateFrom', null] },
                ]}, then: 'declining' },
              ],
              default: 'peak',
            },
          },
        },
      },
    }},
    { $group: { _id: '$maturity', count: { $sum: 1 } } },
  ]);
  const maturity = { peak: 0, early: 0, late: 0, declining: 0, notReady: 0, noProfile: 0 };
  for (const m of maturityRaw) {
    if (m._id in maturity) maturity[m._id] = m.count;
  }
  const bottlesWithProfile = maturity.peak + maturity.early + maturity.late + maturity.declining + maturity.notReady;
  const maturityCoverage = pct(bottlesWithProfile, activeBottles);

  // ── Ratings ─────────────────────────────────────────────────────────────
  // Normalize all ratings to 0–100 (5-star * 20, 20-pt Davis * 5, 100-pt as-is).
  const normRatingExpr = {
    $switch: {
      branches: [
        { case: { $eq: ['$ratingScale', '5']   }, then: { $multiply: ['$rating', 20] } },
        { case: { $eq: ['$ratingScale', '20']  }, then: { $multiply: ['$rating', 5]  } },
        { case: { $eq: ['$ratingScale', '100'] }, then: '$rating' },
      ],
      default: { $multiply: ['$rating', 20] },
    },
  };

  const [ratingOverallRaw, ratingDistRaw, ratingByTypeRaw] = await Promise.all([
    safeAggregate(Bottle, [
      { $match: { ...bottleMatch, rating: { $ne: null, $gt: 0 } } },
      { $addFields: { norm: normRatingExpr } },
      { $group: { _id: null, avg: { $avg: '$norm' }, count: { $sum: 1 } } },
    ]),
    safeAggregate(Bottle, [
      { $match: { ...bottleMatch, rating: { $ne: null, $gt: 0 } } },
      { $addFields: { norm: normRatingExpr } },
      { $bucket: {
        groupBy: '$norm',
        boundaries: [0, 20, 40, 60, 80, 101],
        default: 'other',
        output: { count: { $sum: 1 } },
      }},
    ]),
    safeAggregate(Bottle, [
      { $match: { ...bottleMatch, rating: { $ne: null, $gt: 0 }, wineDefinition: { $ne: null } } },
      { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
      { $unwind: '$wd' },
      { $addFields: { norm: normRatingExpr } },
      { $group: { _id: '$wd.type', avg: { $avg: '$norm' }, count: { $sum: 1 } } },
      { $match: { _id: { $ne: null } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, type: '$_id', avg: { $round: ['$avg', 1] }, count: 1 } },
    ]),
  ]);

  const ratingOverall = ratingOverallRaw[0] || { avg: null, count: 0 };
  const ratingBandLabels = ['0–20', '21–40', '41–60', '61–80', '81–100'];
  const totalRated = ratingDistRaw.reduce((s, r) => s + r.count, 0);
  const ratingDistribution = ratingDistRaw.map((r, i) => ({
    band:  ratingBandLabels[i] || String(r._id),
    count: r.count,
    pct:   pct(r.count, totalRated),
  }));

  // ── Monthly trends (last 12 calendar months) ────────────────────────────
  const buildMonthlySeries = async (model, dateField, baseMatch = {}, extraMatch = {}) => {
    const since = new Date();
    since.setMonth(since.getMonth() - 11, 1);
    since.setHours(0, 0, 0, 0);
    const rows = await safeAggregate(model, [
      { $match: { ...baseMatch, [dateField]: { $gte: since }, ...extraMatch } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m', date: `$${dateField}` } },
        count: { $sum: 1 },
      }},
      { $sort: { _id: 1 } },
    ]);
    // Fill missing months with zero so the series is always exactly 12 entries.
    const series = [];
    const cursor = new Date(since);
    for (let i = 0; i < 12; i++) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      const found = rows.find(r => r._id === key);
      series.push({ month: key, count: found ? found.count : 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return series;
  };

  const [trendBottlesAdded, trendBottlesConsumed, trendNewUsers, trendNewCellars] = await Promise.all([
    buildMonthlySeries(Bottle, 'createdAt',  bottleMatch),
    buildMonthlySeries(Bottle, 'consumedAt', bottleMatch, { status: { $ne: 'active' } }),
    buildMonthlySeries(User,   'createdAt',  userMatch),
    buildMonthlySeries(Cellar, 'createdAt',  cellarMatch),
  ]);

  // ── Most expensive bottles (anonymised — wine + producer + vintage) ─────
  const topExpensiveBottles = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', price: { $gt: 0 }, wineDefinition: { $ne: null } } },
    { $sort: { price: -1 } },
    { $limit: 10 },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $project: {
      _id: 0,
      name:     '$wd.name',
      producer: '$wd.producer',
      vintage:  1,
      price:    1,
      currency: 1,
    }},
  ]);

  // ── Library health ──────────────────────────────────────────────────────
  // Profile + WineDefinition + Rack stats are platform-wide — admin activity
  // on these is product work, not test pollution, so we don't exclude them.
  // Image uploads + wine requests track per-user contributions, so they do
  // honour excludeAdmins.
  const [
    totalRacks,
    profilesTotal,
    profilesReviewed,
    profilesPending,
    pendingWineRequests,
    pendingImageReviews,
    totalImages,
    wineDefinitionsWithBottles,
    totalWineDefinitions,
  ] = await Promise.all([
    Rack.countDocuments(),
    WineVintageProfile.countDocuments(),
    WineVintageProfile.countDocuments({ status: 'reviewed' }),
    WineVintageProfile.countDocuments({ status: 'pending' }),
    WineRequest.countDocuments({ ...requestMatch, status: 'pending' }),
    BottleImage.countDocuments({ ...imageMatch, status: { $in: ['uploaded', 'processing', 'processed'] } }),
    BottleImage.countDocuments(imageMatch),
    Bottle.distinct('wineDefinition', bottleMatch).then(ids => ids.filter(Boolean).length),
    WineDefinition.countDocuments(),
  ]);

  // ── Median bottle price per currency (in-memory percentile) ─────────────
  // Mongo $percentile needs 7.0+; safer to compute from a small sorted list.
  const priceByCurrencyWithMedian = await Promise.all(priceByCurrency.map(async (p) => {
    const prices = await Bottle.find({ ...bottleMatch, status: 'active', price: { $gt: 0 }, currency: p.currency })
      .select('price').sort({ price: 1 }).lean();
    const median = prices.length
      ? prices[Math.floor(prices.length / 2)].price
      : null;
    return { ...p, medianPrice: median };
  }));

  // ── Assemble payload ────────────────────────────────────────────────────
  const avgBottlesPerUser = usersWithBottles > 0 ? Math.round(activeBottles / usersWithBottles) : 0;
  const avgBottlesPerCellar = totalCellars > 0 ? Math.round(activeBottles / totalCellars) : 0;

  return {
    generatedAt: new Date().toISOString(),
    excludeAdmins,
    adminsExcludedCount: excludeAdmins ? adminIds.length : 0,
    overview: {
      totalUsers,
      usersWithBottles,
      totalCellars,
      totalBottles,
      activeBottles,
      consumedBottles,
      drankBottles,
      giftedBottles,
      soldBottles,
      avgBottlesPerUser,
      avgBottlesPerCellar,
      totalWineDefinitions,
    },
    activity: {
      newUsers30,
      newUsers90,
      bottlesAdded30,
      bottlesAdded90,
      bottlesConsumed30,
      bottlesConsumed90,
    },
    engagement: {
      activeUsers24h,
      activeUsers7d,
      activeUsers30d,
      activeUsers90d,
    },
    plans: {
      distribution: planDistribution,
      paidUsers,
      trialEligibleUsers,
      expiringIn7d,
      expiringIn30d,
      withStripeCustomer,
    },
    maturity: {
      ...maturity,
      bottlesWithProfile,
      coveragePct: maturityCoverage,
    },
    ratings: {
      avgNormalized: ratingOverall.avg != null ? round(ratingOverall.avg, 1) : null,
      ratedCount:    ratingOverall.count,
      distribution:  ratingDistribution,
      byType:        ratingByTypeRaw,
    },
    vintage: {
      avgAge: vintage.avgAge != null ? Math.round(vintage.avgAge) : null,
      oldest: vintage.oldest,
      newest: vintage.newest,
      withVintageCount: vintage.count,
      byDecade,
    },
    trends: {
      bottlesAdded:    trendBottlesAdded,
      bottlesConsumed: trendBottlesConsumed,
      newUsers:        trendNewUsers,
      newCellars:      trendNewCellars,
    },
    library: {
      totalWineDefinitions,
      wineDefinitionsWithBottles,
      profilesTotal,
      profilesReviewed,
      profilesPending,
      pendingWineRequests,
      pendingImageReviews,
      totalImages,
      totalRacks,
    },
    byType,
    topCountries,
    topRegions,
    topGrapes,
    topProducers,
    topWines,
    topExpensiveBottles,
    priceByCurrency: priceByCurrencyWithMedian,
    holdingTime,
    byBottleSize,
    cellarSizeDistribution,
  };
}

module.exports = { computeGlobalStats };
