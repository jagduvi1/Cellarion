/**
 * Supported currency codes — the single backend source of truth for currency
 * validation (user preferences, etc.).
 *
 * MUST stay in sync with the frontend list in frontend/src/config/currencies.js
 * (`CURRENCIES`), which drives the currency picker. The two had drifted, so the
 * UI offered currencies (NZD, JPY, HKD, SGD, ZAR) that PATCH /users/preferences
 * then rejected with "Invalid currency".
 *
 * Exchange rates come from open.er-api.com (USD base) and cover all of these;
 * per-currency price caps fall back to USD in utils/priceValidation.js, so any
 * code here works end-to-end without further wiring.
 */
const SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP',
  'SEK', 'NOK', 'DKK',
  'CHF',
  'CAD', 'AUD', 'NZD',
  'JPY', 'HKD', 'SGD',
  'ZAR',
];

// Spellings that mean a supported code but are not one. Chrome's page
// translation turned the add form's "EUR" into "EURO" for members using the
// English interface in Italian (2026-10-13), and a file can carry
// a word or a symbol. Every bottle write stores, and every conversion reads,
// the code they stand for. Mirrored in frontend/src/config/currencies.js.
const CURRENCY_ALIASES = Object.freeze({ EURO: 'EUR', EUROS: 'EUR', '€': 'EUR' });

/** A currency code as stored: trimmed, upper-case, an alias mapped to its code. Non-strings pass through. */
function normalizeCurrency(code) {
  if (typeof code !== 'string') return code;
  const c = code.trim().toUpperCase();
  return CURRENCY_ALIASES[c] || c;
}

/** Whether `code` (after normalizeCurrency) is one the app supports. */
function isSupportedCurrency(code) {
  return SUPPORTED_CURRENCIES.includes(normalizeCurrency(code));
}

/**
 * A currency sent with a new bottle, or as a change: an alias is mapped to its
 * code ("EURO" → "EUR"), and the result must be a supported code. Nothing sent
 * → { ok, value: undefined } (the caller keeps its default).
 */
function parseCurrency(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: 'Invalid currency' };
  const code = normalizeCurrency(value);
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    return { ok: false, error: `Unsupported currency. Allowed: ${SUPPORTED_CURRENCIES.join(', ')}` };
  }
  return { ok: true, value: code };
}

/** The stored spellings that mean `code`: the code itself and its aliases. */
function currencySpellings(code) {
  return [code, ...Object.keys(CURRENCY_ALIASES).filter((a) => CURRENCY_ALIASES[a] === code)];
}

/**
 * A currency from FILE data (an import row, an archive): the supported code
 * it names ("euro" → "EUR"), else `fallback`. A file is not a form — a row
 * saying "kr" or "€ EUR" must not become a bottle's stored code, which stats
 * would then silently drop (audit 2026-10-14).
 */
function currencyOrFallback(value, fallback) {
  const parsed = parseCurrency(value);
  return parsed.ok && parsed.value ? parsed.value : fallback;
}

module.exports = { SUPPORTED_CURRENCIES, CURRENCY_ALIASES, normalizeCurrency, isSupportedCurrency, parseCurrency, currencySpellings, currencyOrFallback };
