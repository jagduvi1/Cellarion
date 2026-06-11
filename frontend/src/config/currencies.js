export const CURRENCIES = [
  'USD', 'EUR', 'GBP',
  'SEK', 'NOK', 'DKK',
  'CHF',
  'CAD', 'AUD', 'NZD',
  'JPY', 'HKD', 'SGD',
  'ZAR'
];
export const DEFAULT_CURRENCY = 'USD';

// Display symbols for wine list menus and PDFs
export const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£',
  SEK: 'kr', NOK: 'kr', DKK: 'kr',
  CHF: 'CHF',
  CAD: 'C$', AUD: 'A$', NZD: 'NZ$',
  JPY: '¥', HKD: 'HK$', SGD: 'S$',
  ZAR: 'R'
};
export const getCurrencySymbol = (code) => CURRENCY_SYMBOLS[code] || '$';
