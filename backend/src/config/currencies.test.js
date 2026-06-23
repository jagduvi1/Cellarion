const { SUPPORTED_CURRENCIES } = require('./currencies');

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
