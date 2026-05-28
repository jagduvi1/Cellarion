/**
 * Thin DB-backed wrapper around the pure validatePriceSanity helper —
 * resolves the user's median bottle price + the latest WineVintagePrice
 * for this wine+vintage, then runs the sanity rules.
 *
 * Used by POST /api/bottles and the import preview/confirm endpoints to
 * surface non-blocking warnings at the moment a price is being entered.
 */
const Bottle = require('../models/Bottle');
const WineVintagePrice = require('../models/WineVintagePrice');
const { validatePriceSanity } = require('../utils/priceValidation');

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

  const cur = (currency || 'USD').toUpperCase();

  const [userMedian, marketPrice] = await Promise.all([
    resolveUserMedian(userId, cur),
    resolveMarketMedian(wineDefinitionId, vintage, cur),
  ]);

  return validatePriceSanity({
    price,
    currency: cur,
    userMedianPrice:   userMedian.median,
    userMedianSample:  userMedian.sample,
    marketMedianPrice: marketPrice,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Coerce a possibly-user-supplied id to either a plain hex string ObjectId
// or a real Mongoose ObjectId instance. Anything else (an injected operator
// object, a non-hex string) returns null, which short-circuits the query.
// Used to defuse CodeQL js/sql-injection on req.body values that reach $match.
function safeObjectIdLike(v) {
  if (v == null) return null;
  if (typeof v === 'string') return /^[a-f0-9]{24}$/i.test(v) ? v : null;
  // Mongoose ObjectId / BSON ObjectId
  if (typeof v === 'object' && typeof v.toHexString === 'function') return v;
  return null;
}

function safeString(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : null;
}

async function resolveUserMedian(userId, currency) {
  const uid = safeObjectIdLike(userId);
  const cur = safeString(currency);
  if (!uid || !cur) return { median: null, sample: 0 };
  const rows = await Bottle
    .find({ user: uid, currency: cur, price: { $gt: 0 } })
    .select('price')
    .sort({ price: 1 })
    .lean();
  if (rows.length === 0) return { median: null, sample: 0 };
  return {
    median: rows[Math.floor(rows.length / 2)].price,
    sample: rows.length,
  };
}

async function resolveMarketMedian(wineDefinitionId, vintage, currency) {
  const wd  = safeObjectIdLike(wineDefinitionId);
  const v   = safeString(vintage);
  const cur = safeString(currency);
  if (!wd || !v || !cur || v === 'NV' || v === 'Unknown') return null;
  const snapshot = await WineVintagePrice
    .findOne({ wineDefinition: wd, vintage: v, currency: cur })
    .sort({ setAt: -1 })
    .lean();
  return snapshot?.price ?? null;
}

/**
 * Bulk-fetch the user's per-currency median bottle price + sample size in a
 * single Mongo aggregation. Used by the import preview to avoid running
 * resolveUserMedian once per row (an N+1 against a potentially-large cellar).
 *
 * Returns `{ USD: { median, sample }, EUR: { median, sample }, ... }`.
 */
async function computeUserMediansByCurrency(userId) {
  const uid = safeObjectIdLike(userId);
  if (!uid) return {};
  const rows = await Bottle.aggregate([
    { $match: { user: uid, price: { $gt: 0 } } },
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
