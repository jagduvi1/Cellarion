/**
 * Price sanity checks — non-blocking warnings surfaced at bottle add /
 * import time to catch fat-finger errors (100× too high, cents-as-units,
 * outliers vs the user's normal collection).
 *
 * These never reject a save — they return an array of warnings the UI
 * shows so the user can confirm or correct. A pure function so it's easy
 * to test and to reuse from both the single-add and import code paths.
 */

// Typical maximum bottle price per currency. Few real bottles exceed
// these on the secondary market (DRC, top Bordeaux 1945, etc.). When a
// user-entered value crosses this, prompt for confirmation.
const ABSOLUTE_CAP = {
  USD:  50000,
  EUR:  50000,
  GBP:  50000,
  CHF:  50000,
  CAD:  70000,
  AUD:  75000,
  NZD:  75000,
  SEK: 500000,
  NOK: 500000,
  DKK: 350000,
  JPY: 7500000,
};

// Soft outlier multipliers — non-blocking heuristics, picked so they
// trigger on obvious mistakes but not on legitimate trophy bottles.
const USER_MEDIAN_MULTIPLE   = 50;  // price > 50× user's own median
const MARKET_MEDIAN_MULTIPLE = 5;   // price > 5× known WineVintagePrice
const CENTS_HEURISTIC_FLOOR  = 10000; // only suggest cents above this

/**
 * @param {object} input
 * @param {number} input.price                Price as entered by the user (in the currency's natural unit, e.g. 260 = €260)
 * @param {string} [input.currency='USD']     ISO 4217 code
 * @param {number} [input.userMedianPrice]    Median of the user's other bottles in the same currency (optional)
 * @param {number} [input.userMedianSample]   How many bottles contributed to that median (skip the user-median rule below ~5 for stability)
 * @param {number} [input.marketMedianPrice]  Latest WineVintagePrice for this wine+vintage in same currency (optional)
 * @returns {Array<{code: string, severity: 'info'|'warning', context: object}>}
 *          Each warning is i18n-key friendly: the UI looks up
 *          `bottles.priceWarning.<code>` and interpolates the context fields.
 */
function validatePriceSanity({
  price,
  currency = 'USD',
  userMedianPrice = null,
  userMedianSample = 0,
  marketMedianPrice = null,
} = {}) {
  const warnings = [];

  // Skip everything if price isn't a positive number — the model's own
  // validation will reject zero/negative; nothing to warn about.
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) return warnings;

  const cur = (currency || 'USD').toUpperCase();

  // ── Rule 1: above absolute typical-maximum cap ──────────────────────────
  const cap = ABSOLUTE_CAP[cur] ?? ABSOLUTE_CAP.USD;
  if (price > cap) {
    warnings.push({
      code: 'absoluteCap',
      severity: 'warning',
      context: { price, currency: cur, cap },
    });
  }

  // ── Rule 2: far outlier vs user's own normal range ──────────────────────
  // Only trigger if we have a representative sample; otherwise a user with
  // 2 bottles where one is 10× the other would always trip the warning.
  if (userMedianPrice && userMedianPrice > 0 && userMedianSample >= 5) {
    const ratio = price / userMedianPrice;
    if (ratio >= USER_MEDIAN_MULTIPLE) {
      warnings.push({
        code: 'userOutlier',
        severity: 'warning',
        context: {
          price,
          currency: cur,
          ratio: Math.round(ratio),
          median: Math.round(userMedianPrice),
        },
      });
    }
  }

  // ── Rule 3: far outlier vs known market price for this wine+vintage ─────
  if (marketMedianPrice && marketMedianPrice > 0) {
    const ratio = price / marketMedianPrice;
    if (ratio >= MARKET_MEDIAN_MULTIPLE) {
      warnings.push({
        code: 'aboveMarket',
        severity: 'warning',
        context: {
          price,
          currency: cur,
          ratio: Math.round(ratio),
          marketPrice: Math.round(marketMedianPrice),
        },
      });
    }
  }

  // ── Rule 4: looks like cents-as-units (round to 100, large) ─────────────
  // Helpful hint, not a hard signal — many real bottles also satisfy this.
  // Only fires above 10,000 to suppress noise.
  if (price >= CENTS_HEURISTIC_FLOOR && price % 100 === 0) {
    warnings.push({
      code: 'possiblyCents',
      severity: 'info',
      context: { price, currency: cur, ifCents: price / 100 },
    });
  }

  return warnings;
}

module.exports = {
  validatePriceSanity,
  // Exported for tests + the rare caller that wants to surface the limits.
  ABSOLUTE_CAP,
  USER_MEDIAN_MULTIPLE,
  MARKET_MEDIAN_MULTIPLE,
  CENTS_HEURISTIC_FLOOR,
};
