import { convertAmount } from './currency';

const RATES = { USD: 1, EUR: 0.9, SEK: 10.5, GBP: 0.8 };

describe('convertAmount', () => {
  test('returns null when rates are not provided', () => {
    expect(convertAmount(100, 'USD', 'EUR', null)).toBeNull();
    expect(convertAmount(100, 'USD', 'EUR', undefined)).toBeNull();
  });

  test('returns null when from and to are the same currency', () => {
    expect(convertAmount(100, 'USD', 'USD', RATES)).toBeNull();
    expect(convertAmount(50, 'EUR', 'EUR', RATES)).toBeNull();
  });

  test('returns null when from currency is missing from rates', () => {
    expect(convertAmount(100, 'XYZ', 'EUR', RATES)).toBeNull();
  });

  test('returns null when to currency is missing from rates', () => {
    expect(convertAmount(100, 'USD', 'XYZ', RATES)).toBeNull();
  });

  test('returns null when from is falsy', () => {
    expect(convertAmount(100, null, 'EUR', RATES)).toBeNull();
    expect(convertAmount(100, '', 'EUR', RATES)).toBeNull();
  });

  test('returns null when to is falsy', () => {
    expect(convertAmount(100, 'USD', null, RATES)).toBeNull();
  });

  test('USD → EUR conversion', () => {
    // 100 USD → 100 / 1 * 0.9 = 90
    expect(convertAmount(100, 'USD', 'EUR', RATES)).toBe(90);
  });

  test('EUR → USD conversion', () => {
    // 90 EUR → 90 / 0.9 * 1 = 100
    expect(convertAmount(90, 'EUR', 'USD', RATES)).toBe(100);
  });

  test('EUR → SEK cross-currency conversion', () => {
    // 100 EUR → 100 / 0.9 * 10.5 ≈ 1166.67
    const result = convertAmount(100, 'EUR', 'SEK', RATES);
    expect(result).toBeCloseTo(1166.67, 1);
  });

  test('result is rounded to 2 decimal places', () => {
    // 1 GBP → 1 / 0.8 * 0.9 = 1.125 → rounds to 1.13
    const result = convertAmount(1, 'GBP', 'EUR', RATES);
    expect(result).toBe(1.13);
  });
});
