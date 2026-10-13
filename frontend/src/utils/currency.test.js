import { convertAmount, convertAmountHistorical } from './currency';
import { normalizeCurrency, getCurrencySymbol } from '../config/currencies';

const RATES = { USD: 1, EUR: 0.9, SEK: 10.5, GBP: 0.8 };

// 2026-10-13: browser page translation stored "EURO" for "EUR" on some bottles.
describe('currency aliases', () => {
  test('normalizeCurrency maps an alias to its code and upper-cases the rest', () => {
    expect(normalizeCurrency('EURO')).toBe('EUR');
    expect(normalizeCurrency(' euros ')).toBe('EUR');
    expect(normalizeCurrency('€')).toBe('EUR');
    expect(normalizeCurrency('sek')).toBe('SEK');
    expect(normalizeCurrency(undefined)).toBeUndefined();
  });

  test('a bottle stored as "EURO" converts as euros, and needs no conversion to EUR', () => {
    expect(convertAmount(90, 'EURO', 'USD', RATES)).toBe(convertAmount(90, 'EUR', 'USD', RATES));
    expect(convertAmount(90, 'EURO', 'EUR', RATES)).toBeNull();
    expect(convertAmountHistorical(90, 'EURO', 'SEK', null, RATES)).toBe(convertAmount(90, 'EUR', 'SEK', RATES));
  });

  test('the symbol of an alias is its code\'s', () => {
    expect(getCurrencySymbol('EURO')).toBe('€');
  });
});

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

describe('convertAmountHistorical', () => {
  const HISTORICAL_RATES = { USD: 1, EUR: 0.8, SEK: 9.0, GBP: 0.7 };
  const LIVE_RATES       = { USD: 1, EUR: 0.9, SEK: 10.5, GBP: 0.8 };

  test('uses historical rates when available', () => {
    // 100 USD → 100 / 1 * 0.8 = 80 EUR  (historical, not 90 from live)
    expect(convertAmountHistorical(100, 'USD', 'EUR', HISTORICAL_RATES, LIVE_RATES)).toBe(80);
  });

  test('falls back to live rates when historical rates are null', () => {
    // 100 USD → 100 / 1 * 0.9 = 90 EUR  (live)
    expect(convertAmountHistorical(100, 'USD', 'EUR', null, LIVE_RATES)).toBe(90);
  });

  test('falls back to live rates when historical rates are undefined', () => {
    expect(convertAmountHistorical(100, 'USD', 'EUR', undefined, LIVE_RATES)).toBe(90);
  });

  test('returns null when both historical and live rates are unavailable', () => {
    expect(convertAmountHistorical(100, 'USD', 'EUR', null, null)).toBeNull();
  });

  test('returns null when from and to are the same currency', () => {
    expect(convertAmountHistorical(100, 'EUR', 'EUR', HISTORICAL_RATES, LIVE_RATES)).toBeNull();
  });

  test('returns null when from is falsy', () => {
    expect(convertAmountHistorical(100, null, 'EUR', HISTORICAL_RATES, LIVE_RATES)).toBeNull();
  });

  test('returns null when to is falsy', () => {
    expect(convertAmountHistorical(100, 'USD', null, HISTORICAL_RATES, LIVE_RATES)).toBeNull();
  });

  test('does not fall back to live rates when same-currency (not a rates failure)', () => {
    // Same currency should return null regardless of fallback rates
    expect(convertAmountHistorical(100, 'SEK', 'SEK', null, LIVE_RATES)).toBeNull();
  });

  test('historical rates produce different result than live rates (core guarantee)', () => {
    // Verify the two rate sets give different results, confirming we use historical
    const historical = convertAmountHistorical(100, 'SEK', 'USD', HISTORICAL_RATES, LIVE_RATES);
    const live       = convertAmount(100, 'SEK', 'USD', LIVE_RATES);
    expect(historical).not.toBe(live);
    // historical: 100 / 9.0 * 1 ≈ 11.11
    expect(historical).toBeCloseTo(11.11, 1);
  });
});
