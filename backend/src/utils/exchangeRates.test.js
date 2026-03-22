// Only test convertCurrency — the pure function that needs no mocking
const { convertCurrency } = require('./exchangeRates');

// Mock the Mongoose model imported at module level so it doesn't require a DB connection
jest.mock('../models/ExchangeRateSnapshot', () => ({}));

describe('convertCurrency', () => {
  const rates = {
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    SEK: 10.5,
    JPY: 150.25,
  };

  // ─── Same currency ────────────────────────────────────────────────────────

  test('same currency returns amount unchanged', () => {
    expect(convertCurrency(100, 'USD', 'USD', rates)).toBe(100);
  });

  test('same currency returns exact amount (no floating point drift)', () => {
    expect(convertCurrency(49.99, 'EUR', 'EUR', rates)).toBe(49.99);
  });

  // ─── Cross-currency conversion ────────────────────────────────────────────

  test('USD to EUR uses correct formula', () => {
    // formula: (amount / fromRate) * toRate = (100 / 1) * 0.92 = 92
    const result = convertCurrency(100, 'USD', 'EUR', rates);
    expect(result).toBeCloseTo(92, 2);
  });

  test('EUR to USD uses correct formula', () => {
    // (100 / 0.92) * 1 ≈ 108.6957
    const result = convertCurrency(100, 'EUR', 'USD', rates);
    expect(result).toBeCloseTo(108.6957, 2);
  });

  test('GBP to SEK cross-conversion', () => {
    // (50 / 0.79) * 10.5 ≈ 664.557
    const result = convertCurrency(50, 'GBP', 'SEK', rates);
    expect(result).toBeCloseTo(664.557, 1);
  });

  test('JPY to EUR cross-conversion', () => {
    // (10000 / 150.25) * 0.92 ≈ 61.23
    const result = convertCurrency(10000, 'JPY', 'EUR', rates);
    expect(result).toBeCloseTo(61.23, 0);
  });

  // ─── Returns null for falsy amount ────────────────────────────────────────

  test('returns null if amount is null', () => {
    expect(convertCurrency(null, 'USD', 'EUR', rates)).toBeNull();
  });

  test('returns null if amount is 0', () => {
    expect(convertCurrency(0, 'USD', 'EUR', rates)).toBeNull();
  });

  test('returns null if amount is undefined', () => {
    expect(convertCurrency(undefined, 'USD', 'EUR', rates)).toBeNull();
  });

  test('returns null if amount is empty string', () => {
    expect(convertCurrency('', 'USD', 'EUR', rates)).toBeNull();
  });

  // ─── Returns null if from or to is missing ────────────────────────────────

  test('returns null if from is null', () => {
    expect(convertCurrency(100, null, 'EUR', rates)).toBeNull();
  });

  test('returns null if to is null', () => {
    expect(convertCurrency(100, 'USD', null, rates)).toBeNull();
  });

  test('returns null if from is empty string', () => {
    expect(convertCurrency(100, '', 'EUR', rates)).toBeNull();
  });

  test('returns null if to is empty string', () => {
    expect(convertCurrency(100, 'USD', '', rates)).toBeNull();
  });

  test('returns null if from is undefined', () => {
    expect(convertCurrency(100, undefined, 'EUR', rates)).toBeNull();
  });

  test('returns null if to is undefined', () => {
    expect(convertCurrency(100, 'USD', undefined, rates)).toBeNull();
  });

  // ─── Returns null if rates is missing ─────────────────────────────────────

  test('returns null if rates is null', () => {
    expect(convertCurrency(100, 'USD', 'EUR', null)).toBeNull();
  });

  test('returns null if rates is undefined', () => {
    expect(convertCurrency(100, 'USD', 'EUR', undefined)).toBeNull();
  });

  // ─── Returns null if currency not in rates ────────────────────────────────

  test('returns null if from currency is not in rates', () => {
    expect(convertCurrency(100, 'XYZ', 'EUR', rates)).toBeNull();
  });

  test('returns null if to currency is not in rates', () => {
    expect(convertCurrency(100, 'USD', 'XYZ', rates)).toBeNull();
  });

  test('returns null if neither currency is in rates', () => {
    expect(convertCurrency(100, 'ABC', 'XYZ', rates)).toBeNull();
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  test('handles very small amounts', () => {
    const result = convertCurrency(0.01, 'USD', 'EUR', rates);
    expect(result).toBeCloseTo(0.0092, 4);
  });

  test('handles negative amounts (amount is truthy)', () => {
    // -100 is truthy, so the function processes it
    const result = convertCurrency(-100, 'USD', 'EUR', rates);
    expect(result).toBeCloseTo(-92, 2);
  });
});
