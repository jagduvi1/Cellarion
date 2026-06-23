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

module.exports = { SUPPORTED_CURRENCIES };
