const { SUPPORTED_CURRENCIES, normalizeCurrency, isSupportedCurrency, currencySpellings } = require('./currencies');

// 2026-10-13: Chrome's page translation turned the add form's "EUR" into "EURO".
describe('normalizeCurrency', () => {
  test('maps an alias to its code, whatever the case and spacing', () => {
    expect(normalizeCurrency('EURO')).toBe('EUR');
    expect(normalizeCurrency(' euro ')).toBe('EUR');
    expect(normalizeCurrency('Euros')).toBe('EUR');
    expect(normalizeCurrency('€')).toBe('EUR');
  });
  test('upper-cases a code and leaves other values alone', () => {
    expect(normalizeCurrency('sek')).toBe('SEK');
    expect(normalizeCurrency('ILS')).toBe('ILS');
    expect(normalizeCurrency(undefined)).toBeUndefined();
    expect(normalizeCurrency(null)).toBeNull();
  });
  test('isSupportedCurrency reads an alias as its code', () => {
    expect(isSupportedCurrency('EURO')).toBe(true);
    expect(isSupportedCurrency('XYZ')).toBe(false);
  });
  test('currencySpellings lists a code with its aliases', () => {
    expect(currencySpellings('EUR')).toEqual(['EUR', 'EURO', 'EUROS', '€']);
    expect(currencySpellings('SEK')).toEqual(['SEK']);
  });
  test('every alias points at a supported code', () => {
    const { CURRENCY_ALIASES } = require('./currencies');
    for (const code of Object.values(CURRENCY_ALIASES)) expect(SUPPORTED_CURRENCIES).toContain(code);
  });
});

describe('SUPPORTED_CURRENCIES', () => {
  // Keep this mirror in sync with frontend/src/config/currencies.js (CURRENCIES).
  const FRONTEND_OFFERED = ['USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK', 'CHF', 'CAD', 'AUD', 'NZD', 'JPY', 'HKD', 'SGD', 'ZAR'];

  test('matches the currencies the frontend picker offers (guards against drift)', () => {
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual([...FRONTEND_OFFERED].sort());
  });

  test('includes the currencies that the stale allowlist used to reject', () => {
    for (const c of ['NZD', 'JPY', 'HKD', 'SGD', 'ZAR']) {
      expect(SUPPORTED_CURRENCIES).toContain(c);
    }
  });

  test('all codes are unique, uppercase, 3-letter codes', () => {
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(SUPPORTED_CURRENCIES.length);
    for (const c of SUPPORTED_CURRENCIES) expect(c).toMatch(/^[A-Z]{3}$/);
  });
});
