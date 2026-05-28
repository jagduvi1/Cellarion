const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');

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
 * @returns {Promise<object>}
 */
async function computeGlobalStats() {
  const currentYear = new Date().getFullYear();
  const since30 = new Date(Date.now() - 30 * 86400000);
  const since90 = new Date(Date.now() - 90 * 86400000);

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
    User.countDocuments(),
    Cellar.countDocuments(),
    Bottle.countDocuments(),
    Bottle.countDocuments({ status: 'active' }),
    Bottle.countDocuments({ status: { $ne: 'active' } }),
    Bottle.countDocuments({ status: 'drank' }),
    Bottle.countDocuments({ status: 'gifted' }),
    Bottle.countDocuments({ status: 'sold' }),
    Bottle.distinct('user').then(ids => ids.length),
    User.countDocuments({ createdAt: { $gte: since30 } }),
    User.countDocuments({ createdAt: { $gte: since90 } }),
    Bottle.countDocuments({ createdAt: { $gte: since30 } }),
    Bottle.countDocuments({ createdAt: { $gte: since90 } }),
    Bottle.countDocuments({ consumedAt: { $gte: since30 } }),
    Bottle.countDocuments({ consumedAt: { $gte: since90 } }),
  ]);

  // ── Country / region / grape / producer breakdowns ──────────────────────
  const topCountries = await safeAggregate(Bottle, [
    { $match: { status: 'active', wineDefinition: { $ne: null } } },
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
    { $match: { status: 'active', wineDefinition: { $ne: null } } },
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
    { $match: { status: 'active', wineDefinition: { $ne: null } } },
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
    { $match: { status: 'active', wineDefinition: { $ne: null } } },
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
    { $match: { status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $group: { _id: '$wd.type', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, type: '$_id', count: 1 } },
  ]);

  // ── Vintage stats ───────────────────────────────────────────────────────
  const vintageRaw = await safeAggregate(Bottle, [
    { $match: { status: 'active', vintage: { $nin: ['NV', null, ''] } } },
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
    { $match: { status: 'active', vintage: { $nin: ['NV', null, ''] } } },
    { $addFields: { yr: { $convert: { input: '$vintage', to: 'int', onError: null, onNull: null } } } },
    { $match: { yr: { $gt: 1800, $lte: currentYear } } },
    { $addFields: { decade: { $multiply: [{ $floor: { $divide: ['$yr', 10] } }, 10] } } },
    { $group: { _id: '$decade', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, decade: '$_id', count: 1 } },
  ]);

  // ── Price (grouped by currency — avoids cross-rate noise) ───────────────
  const priceByCurrency = await safeAggregate(Bottle, [
    { $match: { status: 'active', price: { $gt: 0 } } },
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
    { $match: { status: { $ne: 'active' }, consumedAt: { $ne: null }, purchaseDate: { $ne: null } } },
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
    { $match: { status: 'active' } },
    { $group: { _id: '$bottleSize', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, size: '$_id', count: 1 } },
  ]);

  // ── Cellar-size distribution ────────────────────────────────────────────
  const bottlesPerCellar = await safeAggregate(Bottle, [
    { $match: { status: 'active' } },
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
    { $match: { status: 'active', wineDefinition: { $ne: null } } },
    { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
    { $lookup: { from: 'winedefinitions', localField: '_id', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $project: { _id: 0, name: '$wd.name', producer: '$wd.producer', type: '$wd.type', count: 1 } },
  ]);

  // ── Wine library size ───────────────────────────────────────────────────
  const totalWineDefinitions = await WineDefinition.countDocuments();

  // ── Assemble payload ────────────────────────────────────────────────────
  const avgBottlesPerUser = usersWithBottles > 0 ? Math.round(activeBottles / usersWithBottles) : 0;
  const avgBottlesPerCellar = totalCellars > 0 ? Math.round(activeBottles / totalCellars) : 0;

  return {
    generatedAt: new Date().toISOString(),
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
    vintage: {
      avgAge: vintage.avgAge != null ? Math.round(vintage.avgAge) : null,
      oldest: vintage.oldest,
      newest: vintage.newest,
      withVintageCount: vintage.count,
      byDecade,
    },
    byType,
    topCountries,
    topRegions,
    topGrapes,
    topProducers,
    topWines,
    priceByCurrency,
    holdingTime,
    byBottleSize,
    cellarSizeDistribution,
  };
}

module.exports = { computeGlobalStats };
