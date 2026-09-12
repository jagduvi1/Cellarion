import { toMaturityArray, ratingRangeLabel, NEEDS_ATTENTION, MATURITY_FILTER_OPTIONS } from './filterLabels';

// t() that returns the English default with its placeholders substituted.
const t = (key, fallback, vars = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);

describe('toMaturityArray', () => {
  test('arrays pass through, empties dropped', () => {
    expect(toMaturityArray(['late', '', 'declining'])).toEqual(['late', 'declining']);
  });
  test('a legacy single string (old sessionStorage / bookmark) becomes a one-element array', () => {
    expect(toMaturityArray('peak')).toEqual(['peak']);
  });
  test('a comma-separated URL value splits and trims', () => {
    expect(toMaturityArray('late, declining')).toEqual(['late', 'declining']);
  });
  test('empty / null / undefined → []', () => {
    expect(toMaturityArray('')).toEqual([]);
    expect(toMaturityArray(null)).toEqual([]);
    expect(toMaturityArray(undefined)).toEqual([]);
  });
  test('the preset is late + declining and both are offered buckets', () => {
    expect(NEEDS_ATTENTION).toEqual(['late', 'declining']);
    for (const v of NEEDS_ATTENTION) expect(MATURITY_FILTER_OPTIONS).toContain(v);
  });
});

describe('ratingRangeLabel — normalised bounds rendered in the user scale', () => {
  test('both bounds → "a to b" in stars, one decimal', () => {
    // 50 = 3.0★, 75 = 4.0★ on the anchor table
    expect(ratingRangeLabel(t, '50', '75', '5')).toBe('3.0★ to 4.0★');
  });
  test('min only → "x and up"; max only → "Up to x"', () => {
    expect(ratingRangeLabel(t, '70', '', '5')).toBe('3.8★ and up');
    expect(ratingRangeLabel(t, '', '84', '5')).toBe('Up to 4.4★');
  });
  test('the same bounds read in the Parker scale for a 100-point user', () => {
    expect(ratingRangeLabel(t, '50', '75', '100')).toBe('82pts to 91pts');
  });
  test('neither bound → null (no chip)', () => {
    expect(ratingRangeLabel(t, '', '', '5')).toBeNull();
    expect(ratingRangeLabel(t, undefined, null, '5')).toBeNull();
  });
});
