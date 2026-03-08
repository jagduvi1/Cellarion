const {
  toNormalized,
  fromNormalized,
  convertRating,
  isValidRating,
  resolveRating,
} = require('./ratingUtils');

// ── toNormalized ──────────────────────────────────────────────────────────────
describe('toNormalized', () => {
  test('null → null', () => expect(toNormalized(null, '5')).toBeNull());
  test('undefined → null', () => expect(toNormalized(undefined, '5')).toBeNull());

  test('5-star: 5 → 100', () => expect(toNormalized(5, '5')).toBe(100));
  test('5-star: 2.5 → 50', () => expect(toNormalized(2.5, '5')).toBe(50));

  test('20-pt: 20 → 100', () => expect(toNormalized(20, '20')).toBe(100));
  test('20-pt: 10 → 50', () => expect(toNormalized(10, '20')).toBe(50));

  test('100-pt: 100 → 100', () => expect(toNormalized(100, '100')).toBe(100));
  test('100-pt: 50 → 0', () => expect(toNormalized(50, '100')).toBe(0));
  test('100-pt: 75 → 50', () => expect(toNormalized(75, '100')).toBe(50));

  test('unknown scale falls back to 5-star', () => {
    expect(toNormalized(5, 'unknown')).toBe(100);
  });
});

// ── fromNormalized ─────────────────────────────────────────────────────────────
describe('fromNormalized', () => {
  test('null → null', () => expect(fromNormalized(null, '5')).toBeNull());

  test('100-pt floor: 0 → 50', () => expect(fromNormalized(0, '100')).toBe(50));
  test('100-pt ceiling: 100 → 100', () => expect(fromNormalized(100, '100')).toBe(100));
  test('5-star: 100 → 5', () => expect(fromNormalized(100, '5')).toBe(5));
  test('20-pt: 50 → 10', () => expect(fromNormalized(50, '20')).toBe(10));
});

// ── convertRating ──────────────────────────────────────────────────────────────
describe('convertRating', () => {
  test('same scale returns same value', () => {
    expect(convertRating(4, '5', '5')).toBe(4);
  });

  test('null → null', () => expect(convertRating(null, '5', '100')).toBeNull());

  test('5-star 5 → 100-pt 100', () => {
    expect(convertRating(5, '5', '100')).toBe(100);
  });

  test('5-star 2.5 → 100-pt 75', () => {
    expect(convertRating(2.5, '5', '100')).toBe(75);
  });

  test('100-pt 75 → 5-star 2.5', () => {
    expect(convertRating(75, '100', '5')).toBe(2.5);
  });
});

// ── isValidRating ──────────────────────────────────────────────────────────────
describe('isValidRating', () => {
  test('null → false', () => expect(isValidRating(null, '5')).toBe(false));
  test('unknown scale → false', () => expect(isValidRating(3, 'unknown')).toBe(false));

  test('5-star: 1 valid', () => expect(isValidRating(1, '5')).toBe(true));
  test('5-star: 5 valid', () => expect(isValidRating(5, '5')).toBe(true));
  test('5-star: 0 invalid (below min 1)', () => expect(isValidRating(0, '5')).toBe(false));
  test('5-star: 5.1 invalid', () => expect(isValidRating(5.1, '5')).toBe(false));

  test('100-pt: 50 valid (floor)', () => expect(isValidRating(50, '100')).toBe(true));
  test('100-pt: 49 invalid (below floor)', () => expect(isValidRating(49, '100')).toBe(false));
  test('100-pt: 100 valid', () => expect(isValidRating(100, '100')).toBe(true));

  test('20-pt: 1 valid', () => expect(isValidRating(1, '20')).toBe(true));
  test('20-pt: 20.1 invalid', () => expect(isValidRating(20.1, '20')).toBe(false));
});

// ── resolveRating ──────────────────────────────────────────────────────────────
describe('resolveRating', () => {
  test('no rating → { rating: undefined, ratingScale: "5" }', () => {
    expect(resolveRating(undefined, undefined)).toEqual({ rating: undefined, ratingScale: '5' });
  });

  test('empty string rating → { rating: undefined, ratingScale }', () => {
    expect(resolveRating('', '20')).toEqual({ rating: undefined, ratingScale: '20' });
  });

  test('null rating → { rating: undefined, ratingScale }', () => {
    expect(resolveRating(null, '100')).toEqual({ rating: undefined, ratingScale: '100' });
  });

  test('unknown scale defaults to "5"', () => {
    const result = resolveRating(4, 'invalid');
    expect(result.ratingScale).toBe('5');
    expect(result.rating).toBe(4);
  });

  test('valid 5-star rating → parses to float', () => {
    expect(resolveRating('4.5', '5')).toEqual({ rating: 4.5, ratingScale: '5' });
  });

  test('valid 100-pt rating', () => {
    expect(resolveRating(92, '100')).toEqual({ rating: 92, ratingScale: '100' });
  });

  test('out-of-range → returns error string', () => {
    const result = resolveRating(6, '5');
    expect(result.error).toMatch(/out of range/);
    expect(result.ratingScale).toBe('5');
    expect(result.rating).toBeUndefined();
  });

  test('100-pt below 50 is out of range', () => {
    const result = resolveRating(49, '100');
    expect(result.error).toMatch(/out of range/);
  });
});
