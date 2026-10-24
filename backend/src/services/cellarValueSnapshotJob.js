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
const { getOrCreateDailySnapshot, getRecentSnapshot, convertCurrency } = require('../utils/exchangeRates');
const { resolveReplacementForBottles } = require('./valuation');

// How old stored rates may be to stand in for today's.
const FALLBACK_RATES_MAX_AGE_DAYS = 7;

async function runCellarValueSnapshots() {
  const today = new Date().toISOString().slice(0, 10);

  let rates = null;
  try {
    const snap = await getOrCreateDailySnapshot();
    rates = snap?.rates || null;
  } catch (_) {}

  // Snapshots are stored in USD. When today's rates cannot be fetched, the
  // newest stored rates of the past week stand in: a few days' drift in a rate
  // costs less than every member's weekly point. With none, a non-USD amount
  // has no USD value, and a point that adds SEK as if it were dollars is worse
  // than a missing week on the chart.
  if (!rates) {
    let recent = null;
    try {
      recent = await getRecentSnapshot(FALLBACK_RATES_MAX_AGE_DAYS);
    } catch (_) {}
    if (!recent?.rates) {
      console.warn(`[cellarValueSnapshot] No exchange rates from the last ${FALLBACK_RATES_MAX_AGE_DAYS} days — run skipped`);
      return;
    }
    rates = recent.rates;
    console.warn(`[cellarValueSnapshot] No exchange rates today — using the stored rates of ${recent.date}`);
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

      // Add an amount in USD with the run's rates. An amount whose currency is
      // not in the rates map has no USD value: it is left out and counted,
      // never added as if it were USD.
      const addUsd = (entry, field, amount, currency) => {
        const usd = convertCurrency(amount, currency || 'USD', 'USD', rates);
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
    + (skippedAmounts ? ` — ${skippedAmounts} amount(s) skipped: currency not in the rates` : ''));
}

module.exports = { runCellarValueSnapshots };
