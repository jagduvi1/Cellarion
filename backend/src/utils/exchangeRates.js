const https = require('https');
const ExchangeRateSnapshot = require('../models/ExchangeRateSnapshot');

/**
 * Fetches current USD-based exchange rates from open.er-api.com.
 * Returns a plain rates object like { USD: 1, EUR: 0.92, SEK: 10.5, ... }
 * Returns null on failure — callers should degrade gracefully.
 */
function fetchExchangeRates() {
  return new Promise((resolve) => {
    https.get('https://open.er-api.com/v6/latest/USD', (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(data.result === 'success' && data.rates ? data.rates : null);
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Returns today's ExchangeRateSnapshot, creating it (with a fresh API call)
 * if one does not exist yet. At most one outbound rate-fetch per calendar day.
 * Returns null if rates are unavailable — callers degrade gracefully.
 */
async function getOrCreateDailySnapshot() {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const existing = await ExchangeRateSnapshot.findOne({ date: today }).lean();
  if (existing) return existing;

  const rates = await fetchExchangeRates();
  if (!rates) return null;

  // Upsert handles concurrent requests on the same day
  return ExchangeRateSnapshot.findOneAndUpdate(
    { date: today },
    { $setOnInsert: { date: today, rates, fetchedAt: new Date() } },
    { upsert: true, new: true, lean: true }
  );
}

/**
 * Fetches the snapshot for a single date string ('YYYY-MM-DD').
 * Returns null if no snapshot exists for that date.
 */
function getSnapshotForDate(date) {
  if (!date) return Promise.resolve(null);
  return ExchangeRateSnapshot.findOne({ date }).lean();
}

/**
 * Batch-fetches snapshots for an array of date strings.
 * Returns a Map<date, rates> for quick lookups.
 */
async function getSnapshotsForDates(dates) {
  if (!dates || dates.length === 0) return new Map();
  const snapshots = await ExchangeRateSnapshot.find({ date: { $in: dates } }).lean();
  return new Map(snapshots.map(s => [s.date, s.rates]));
}

/**
 * Converts an amount from one currency to another using a USD-based rates map.
 * Returns null if the conversion is not possible (missing rates, same currency is handled as a no-op).
 *
 * @param {number} amount
 * @param {string} from  - ISO currency code of the source amount
 * @param {string} to    - ISO currency code of the target
 * @param {object} rates - plain rates map { USD: 1, EUR: 0.92, ... }
 * @returns {number|null}
 */
function convertCurrency(amount, from, to, rates) {
  if (!amount || !from || !to || !rates) return null;
  if (from === to) return amount;
  const fromRate = rates[from];
  const toRate   = rates[to];
  if (!fromRate || !toRate) return null;
  return (amount / fromRate) * toRate;
}

module.exports = { fetchExchangeRates, getOrCreateDailySnapshot, getSnapshotForDate, getSnapshotsForDates, convertCurrency };
