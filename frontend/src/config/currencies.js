export const CURRENCIES = [
  'USD', 'EUR', 'GBP',
  'SEK', 'NOK', 'DKK',
  'CHF',
  'CAD', 'AUD', 'NZD',
  'JPY', 'HKD', 'SGD',
  'ZAR'
];

// Display symbols for wine list menus and PDFs
export const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£',
  SEK: 'kr', NOK: 'kr', DKK: 'kr',
  CHF: 'CHF',
  CAD: 'C$', AUD: 'A$', NZD: 'NZ$',
  JPY: '¥', HKD: 'HK$', SGD: 'S$',
  ZAR: 'R'
};
// Spellings that mean a supported code but are not one. Chrome's page
// translation turned the add form's "EUR" into "EURO" (2026-10-13), so some
// bottles were stored that way; they read as the code they stand for.
// Mirrors backend/src/config/currencies.js.
export const CURRENCY_ALIASES = { EURO: 'EUR', EUROS: 'EUR', '€': 'EUR' };

/** A currency code as the app uses it: trimmed, upper-case, an alias mapped. Non-strings pass through. */
export function normalizeCurrency(code) {
  if (typeof code !== 'string') return code;
  const c = code.trim().toUpperCase();
  return CURRENCY_ALIASES[c] || c;
}

export const getCurrencySymbol = (code) => CURRENCY_SYMBOLS[normalizeCurrency(code)] || '$';
