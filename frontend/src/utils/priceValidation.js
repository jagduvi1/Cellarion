// Mirror of backend/src/utils/priceValidation.js so the add-bottle form can
// surface sanity warnings as the user types — no round-trip required.
// Keep these constants in sync with the backend (they live in the same
// repository so drift is easy to spot in code review).

export const ABSOLUTE_CAP = {
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

export const USER_MEDIAN_MULTIPLE   = 50;
export const MARKET_MEDIAN_MULTIPLE = 5;
// Cents-heuristic floor is derived PER CURRENCY (cap ÷ divisor, never below
// the minimum) — a flat 10,000 floor made ordinary JPY (>¥10k ≈ $66) and SEK
// bottles constantly trip the "did you mean ÷100?" hint. Mirrors the backend.
export const CENTS_HEURISTIC_FLOOR       = 10000;
export const CENTS_HEURISTIC_CAP_DIVISOR = 5;

export function centsHeuristicFloor(cap) {
  return Math.max(CENTS_HEURISTIC_FLOOR, cap / CENTS_HEURISTIC_CAP_DIVISOR);
}

/**
 * Pure function — same signature as the backend so the two can never drift
 * silently in either direction. The frontend usually only has access to
 * `price` and `currency` (no user median, no market price) and that's fine;
 * the absolute-cap and possibly-cents rules already catch the bulk of
 * obvious mistakes.
 */
export function validatePriceSanity({
  price,
  currency = 'USD',
  userMedianPrice = null,
  userMedianSample = 0,
  marketMedianPrice = null,
} = {}) {
  const warnings = [];
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) return warnings;

  const cur = (currency || 'USD').toUpperCase();

  const cap = ABSOLUTE_CAP[cur] ?? ABSOLUTE_CAP.USD;
  if (price > cap) {
    warnings.push({ code: 'absoluteCap', severity: 'warning', context: { price, currency: cur, cap } });
  }

  if (userMedianPrice && userMedianPrice > 0 && userMedianSample >= 5) {
    const ratio = price / userMedianPrice;
    if (ratio >= USER_MEDIAN_MULTIPLE) {
      warnings.push({
        code: 'userOutlier',
        severity: 'warning',
        context: { price, currency: cur, ratio: Math.round(ratio), median: Math.round(userMedianPrice) },
      });
    }
  }

  if (marketMedianPrice && marketMedianPrice > 0) {
    const ratio = price / marketMedianPrice;
    if (ratio >= MARKET_MEDIAN_MULTIPLE) {
      warnings.push({
        code: 'aboveMarket',
        severity: 'warning',
        context: { price, currency: cur, ratio: Math.round(ratio), marketPrice: Math.round(marketMedianPrice) },
      });
    }
  }

  if (price >= centsHeuristicFloor(cap) && price % 100 === 0) {
    warnings.push({
      code: 'possiblyCents',
      severity: 'info',
      context: { price, currency: cur, ifCents: price / 100 },
    });
  }

  return warnings;
}

/**
 * Plain-English description of a single warning — used in import preview
 * tooltips and other contexts where i18n's `t()` isn't wired up.
 * AddBottle uses `t('bottles.priceWarning.<code>', context)` instead so the
 * messages translate. Keep the wording here close to the en.json copy.
 */
export function describePriceWarning(w) {
  const fmt = (n) => Number(n).toLocaleString();
  const { code, context: c = {} } = w;
  switch (code) {
    case 'absoluteCap':
      return `Unusually high — above the typical maximum of ${fmt(c.cap)} ${c.currency} per bottle.`;
    case 'userOutlier':
      return `${c.ratio}× higher than your typical bottle (${fmt(c.median)} ${c.currency}).`;
    case 'aboveMarket':
      return `${c.ratio}× the recorded market price (${fmt(c.marketPrice)} ${c.currency}) for this wine and vintage.`;
    case 'possiblyCents':
      return `Looks like cents — if you meant ${fmt(c.ifCents)} ${c.currency}, divide by 100.`;
    default:
      return code;
  }
}
