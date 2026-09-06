const { sanitizeImportWarnings } = require('./importWarnings');

describe('sanitizeImportWarnings (audit 2026-09 D13-12)', () => {
  test('keeps code, count and sample, bounded', () => {
    const out = sanitizeImportWarnings([{ code: 'ct-truncated', count: 12, sample: 'x'.repeat(500), extra: { huge: 'y'.repeat(10000) } }]);
    expect(out).toEqual([{ code: 'ct-truncated', count: 12, sample: 'x'.repeat(200) }]);
  });
  test('drops entries without a code, non-objects, and everything past twenty', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ code: `w${i}` }));
    expect(sanitizeImportWarnings(many)).toHaveLength(20);
    expect(sanitizeImportWarnings([null, 'text', 42, { count: 3 }, { code: '   ' }])).toEqual([]);
  });
  test('caps the code and refuses non-finite counts', () => {
    const out = sanitizeImportWarnings([{ code: 'c'.repeat(100), count: Infinity }]);
    expect(out).toEqual([{ code: 'c'.repeat(40) }]);
  });
  test('anything that is not an array is an empty list', () => {
    expect(sanitizeImportWarnings(undefined)).toEqual([]);
    expect(sanitizeImportWarnings({ code: 'x' })).toEqual([]);
    expect(sanitizeImportWarnings('x')).toEqual([]);
  });
});
