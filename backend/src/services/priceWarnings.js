/**
 * Thin DB-backed wrapper around the pure validatePriceSanity helper —
 * resolves the user's median bottle price + the latest WineVintagePrice
 * for this wine+vintage, then runs the sanity rules.
 *
 * Used by POST /api/bottles and the import preview/confirm endpoints to
 * surface non-blocking warnings at the moment a price is being entered.
 *
 * Security note (CodeQL js/sql-injection): callers may pass values that
 * originate in req.body. Every value used in a $match / find / findOne
 * argument is coerced via String() and (for ObjectIds) checked against a
 * 24-hex regex INLINE before reaching the Mongo query — operator objects
 * like {$ne: null} stringify to "[object Object]" which can't match any
 * legitimate document. The inline pattern is what CodeQL's taint analysis
 * recognises as sanitisation; extracting it into a helper hid the
 * sanitiser from the static analyser.
 */
const Bottle = require('../models/Bottle');
const WineVintagePrice = require('../models/WineVintagePrice');
const { validatePriceSanity } = require('../utils/priceValidation');

const HEX24 = /^[a-f0-9]{24}$/i;

/**
 * @param {object} input
 * @param {number}        input.price
 * @param {string}        [input.currency='USD']
 * @param {ObjectId|null} [input.userId]
 * @param {ObjectId|null} [input.wineDefinitionId]
 * @param {string|null}   [input.vintage]
 * @returns {Promise<Array>}
 */
async function gatherPriceWarnings({
  price,
  currency = 'USD',
  userId = null,
  wineDefinitionId = null,
  vintage = null,
} = {}) {
  // Cheap exit — no price, no warnings to gather, no DB queries.
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) return [];

  // ── Inline sanitisation (CodeQL js/sql-injection sanitiser) ─────────────
  // String() forces primitive output. The regex guards an ObjectId-shaped
  // string. Non-string values become "[object Object]" / "undefined" and
  // either fail the regex (ObjectId case) or simply don't match any
  // legitimate document (currency / vintage case).
  const cur     = String(currency || 'USD').toUpperCase();
  const uidStr  = userId == null ? '' : String(userId);
  const wdStr   = wineDefinitionId == null ? '' : String(wineDefinitionId);
  const vinStr  = vintage == null ? '' : String(vintage);
  const uidOk   = HEX24.test(uidStr);
  const wdOk    = HEX24.test(wdStr);

  // ── Resolve the two reference prices in parallel ────────────────────────
  const [userMedian, marketPrice] = await Promise.all([
    uidOk ? findUserMedian(uidStr, cur) : Promise.resolve({ median: null, sample: 0 }),
    (wdOk && vinStr && vinStr !== 'NV' && vinStr !== 'Unknown')
      ? findMarketMedian(wdStr, vinStr, cur)
      : Promise.resolve(null),
  ]);

  return validatePriceSanity({
    price,
    currency: cur,
    userMedianPrice:   userMedian.median,
    userMedianSample:  userMedian.sample,
    marketMedianPrice: marketPrice,
  });
}

// ── Resolvers (inputs already sanitised by the caller) ───────────────────────

async function findUserMedian(userIdHex, currency) {
  // Inputs were String()'d + regex-validated by the caller; safe to use
  // directly in the query without further conversion.
  const rows = await Bottle
    .find({ user: userIdHex, currency, price: { $gt: 0 } })
    .select('price')
    .sort({ price: 1 })
    .lean();
  if (rows.length === 0) return { median: null, sample: 0 };
  return {
    median: rows[Math.floor(rows.length / 2)].price,
    sample: rows.length,
  };
}

async function findMarketMedian(wineDefinitionIdHex, vintage, currency) {
  const snapshot = await WineVintagePrice
    .findOne({ wineDefinition: wineDefinitionIdHex, vintage, currency })
    .sort({ setAt: -1 })
    .lean();
  return snapshot?.price ?? null;
}

/**
 * Bulk-fetch the user's per-currency median bottle price + sample size in a
 * single Mongo aggregation. Used by the import preview to avoid running
 * findUserMedian once per row (an N+1 against a potentially-large cellar).
 *
 * Returns `{ USD: { median, sample }, EUR: { median, sample }, ... }`.
 */
async function computeUserMediansByCurrency(userId) {
  if (userId == null) return {};
  // Inline String() + HEX24 sanitisation — same pattern as gatherPriceWarnings.
  const uidStr = String(userId);
  if (!HEX24.test(uidStr)) return {};
  const rows = await Bottle.aggregate([
    { $match: { user: uidStr, price: { $gt: 0 } } },
    { $sort: { currency: 1, price: 1 } },
    { $group: {
      _id: '$currency',
      prices: { $push: '$price' },
    }},
  ]);
  const out = {};
  for (const row of rows) {
    const cur = (row._id || 'USD').toUpperCase();
    const n = row.prices.length;
    out[cur] = { median: row.prices[Math.floor(n / 2)], sample: n };
  }
  return out;
}

module.exports = { gatherPriceWarnings, computeUserMediansByCurrency };
