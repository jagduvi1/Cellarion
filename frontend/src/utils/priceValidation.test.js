import { validatePriceSanity, centsHeuristicFloor, ABSOLUTE_CAP } from './priceValidation';

const codes = (warnings) => warnings.map(w => w.code);

describe('centsHeuristicFloor', () => {
  it('is the legacy 10,000 for USD/EUR-magnitude currencies', () => {
    expect(centsHeuristicFloor(ABSOLUTE_CAP.USD)).toBe(10000);
    expect(centsHeuristicFloor(ABSOLUTE_CAP.EUR)).toBe(10000);
  });

  it('scales with the currency cap for high-denomination currencies', () => {
    expect(centsHeuristicFloor(ABSOLUTE_CAP.SEK)).toBe(100000);
    expect(centsHeuristicFloor(ABSOLUTE_CAP.JPY)).toBe(1500000);
  });
});

describe('validatePriceSanity cents heuristic (per-currency floor)', () => {
  it('still flags a round USD price at 10,000+', () => {
    expect(codes(validatePriceSanity({ price: 10000, currency: 'USD' }))).toContain('possiblyCents');
  });

  it('no longer flags ordinary SEK and JPY prices the backend accepts', () => {
    // Regression: the flat 10,000 floor tripped on every round SEK >= 10 000 kr
    // and JPY >= ¥10,000 while the backend (fixed first) stayed silent.
    expect(codes(validatePriceSanity({ price: 12000, currency: 'SEK' }))).not.toContain('possiblyCents');
    expect(codes(validatePriceSanity({ price: 50000, currency: 'JPY' }))).not.toContain('possiblyCents');
  });

  it('flags SEK/JPY prices above their scaled floors', () => {
    expect(codes(validatePriceSanity({ price: 100000, currency: 'SEK' }))).toContain('possiblyCents');
    expect(codes(validatePriceSanity({ price: 1500000, currency: 'JPY' }))).toContain('possiblyCents');
  });

  it('keeps the absolute-cap warning independent of the cents floor', () => {
    expect(codes(validatePriceSanity({ price: 600000, currency: 'SEK' }))).toContain('absoluteCap');
  });
});
