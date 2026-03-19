/**
 * Cellar value snapshot job — runs weekly via the scheduler.
 *
 * Computes each user's cellar value (in USD) and stores a snapshot
 * for the time-series "Collection Value Over Time" chart.
 */
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const { CONSUMED_STATUSES } = require('../config/constants');
const { getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');

async function runCellarValueSnapshots() {
  const today = new Date().toISOString().slice(0, 10);

  let todayRates = null;
  try {
    const snap = await getOrCreateDailySnapshot();
    todayRates = snap?.rates || null;
  } catch (_) {}

  // All users who have at least one cellar
  const userIds = await Cellar.distinct('user', { deletedAt: null });

  let snapshotCount = 0;

  for (const userId of userIds) {
    try {
      const cellars = await Cellar.find({ user: userId, deletedAt: null }).select('_id').lean();
      const cellarIds = cellars.map(c => c._id);

      const bottles = await Bottle.find({
        user: userId,
        cellar: { $in: cellarIds },
        status: { $nin: CONSUMED_STATUSES },
        price: { $gt: 0 }
      }).select('cellar price currency').lean();

      // Group by cellar
      const byCellar = {};
      for (const cid of cellarIds) {
        byCellar[cid.toString()] = { totalValue: 0, bottleCount: 0 };
      }

      for (const b of bottles) {
        const cid = b.cellar.toString();
        if (!byCellar[cid]) byCellar[cid] = { totalValue: 0, bottleCount: 0 };

        let usdValue = b.price;
        const fromCurrency = b.currency || 'USD';
        if (fromCurrency !== 'USD' && todayRates) {
          const converted = convertCurrency(b.price, fromCurrency, 'USD', todayRates);
          if (converted != null) usdValue = converted;
        }

        byCellar[cid].totalValue += usdValue;
        byCellar[cid].bottleCount++;
      }

      // Also count bottles without price for bottleCount
      const allBottles = await Bottle.find({
        user: userId,
        cellar: { $in: cellarIds },
        status: { $nin: CONSUMED_STATUSES }
      }).select('cellar').lean();

      const countByCellar = {};
      for (const b of allBottles) {
        const cid = b.cellar.toString();
        countByCellar[cid] = (countByCellar[cid] || 0) + 1;
      }

      // Upsert snapshots
      const ops = cellarIds.map(cid => {
        const key = cid.toString();
        return {
          updateOne: {
            filter: { cellar: cid, date: today },
            update: {
              $set: {
                user: userId,
                cellar: cid,
                date: today,
                totalValue: Math.round((byCellar[key]?.totalValue || 0) * 100) / 100,
                bottleCount: countByCellar[key] || 0
              }
            },
            upsert: true
          }
        };
      });

      if (ops.length > 0) {
        await CellarValueSnapshot.bulkWrite(ops);
        snapshotCount += ops.length;
      }
    } catch (err) {
      console.error(`[cellarValueSnapshot] Error for user ${userId}:`, err.message);
    }
  }

  console.log(`[cellarValueSnapshot] Created ${snapshotCount} snapshot(s) for ${userIds.length} user(s)`);
}

module.exports = { runCellarValueSnapshots };
