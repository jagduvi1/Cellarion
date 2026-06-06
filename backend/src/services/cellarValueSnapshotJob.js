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
const { resolveReplacementForBottles } = require('./valuation');

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

      // All active bottles in one pass: cost basis (price), replacement value
      // (resolved estimate), and bottle count.
      const bottles = await Bottle.find({
        user: userId,
        cellar: { $in: cellarIds },
        status: { $nin: CONSUMED_STATUSES }
      }).select('cellar price currency wineDefinition vintage').lean();

      // Replacement estimate per bottle (secondary ?? currentRelease ?? paid).
      const replMap = await resolveReplacementForBottles(bottles);

      // Convert any amount to USD using today's rates (falls back to the raw
      // amount if rates are unavailable).
      const toUsd = (amount, currency) => {
        const from = currency || 'USD';
        if (from === 'USD' || !todayRates) return amount;
        const converted = convertCurrency(amount, from, 'USD', todayRates);
        return converted != null ? converted : amount;
      };

      // Group by cellar
      const byCellar = {};
      for (const cid of cellarIds) {
        byCellar[cid.toString()] = { totalValue: 0, replacementValue: 0, bottleCount: 0 };
      }

      for (const b of bottles) {
        const cid = b.cellar.toString();
        if (!byCellar[cid]) byCellar[cid] = { totalValue: 0, replacementValue: 0, bottleCount: 0 };

        byCellar[cid].bottleCount++;

        if (b.price > 0) byCellar[cid].totalValue += toUsd(b.price, b.currency);

        const repl = replMap.get(b._id.toString());
        if (repl) byCellar[cid].replacementValue += toUsd(repl.amount, repl.currency);
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
                replacementValue: Math.round((byCellar[key]?.replacementValue || 0) * 100) / 100,
                bottleCount: byCellar[key]?.bottleCount || 0
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
