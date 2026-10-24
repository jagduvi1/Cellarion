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
const { NOT_IN_CELLAR_STATUSES } = require('../config/constants');
const { getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
const { resolveReplacementForBottles } = require('./valuation');

async function runCellarValueSnapshots() {
  const today = new Date().toISOString().slice(0, 10);

  let todayRates = null;
  try {
    const snap = await getOrCreateDailySnapshot();
    todayRates = snap?.rates || null;
  } catch (_) {}

  // Snapshots are stored in USD. Without today's rates a non-USD amount has no
  // USD value, and a point that adds SEK as if it were dollars is worse than a
  // missing week on the chart.
  if (!todayRates) {
    console.warn('[cellarValueSnapshot] No exchange rates available today — run skipped');
    return;
  }

  // All users who have at least one cellar
  const userIds = await Cellar.distinct('user', { deletedAt: null });

  let snapshotCount = 0;
  let skippedAmounts = 0;

  for (const userId of userIds) {
    try {
      const cellars = await Cellar.find({ user: userId, deletedAt: null }).select('_id').lean();
      const cellarIds = cellars.map(c => c._id);

      // All active bottles in one pass: cost basis (price), replacement value
      // (resolved estimate), and bottle count.
      const bottles = await Bottle.find({
        user: userId,
        cellar: { $in: cellarIds },
        status: { $nin: NOT_IN_CELLAR_STATUSES }
      }).select('cellar price currency wineDefinition vintage').lean();

      // Replacement estimate per bottle (secondary ?? currentRelease ?? paid).
      const replMap = await resolveReplacementForBottles(bottles);

      // Add an amount in USD with today's rates. An amount whose currency is
      // not in the rates map has no USD value: it is left out and counted,
      // never added as if it were USD.
      const addUsd = (entry, field, amount, currency) => {
        const usd = convertCurrency(amount, currency || 'USD', 'USD', todayRates);
        if (usd == null) skippedAmounts++;
        else entry[field] += usd;
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

        if (b.price > 0) addUsd(byCellar[cid], 'totalValue', b.price, b.currency);

        const repl = replMap.get(b._id.toString());
        if (repl) addUsd(byCellar[cid], 'replacementValue', repl.amount, repl.currency);
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

  console.log(`[cellarValueSnapshot] Created ${snapshotCount} snapshot(s) for ${userIds.length} user(s)`
    + (skippedAmounts ? ` — ${skippedAmounts} amount(s) skipped: currency not in today's rates` : ''));
}

module.exports = { runCellarValueSnapshots };
