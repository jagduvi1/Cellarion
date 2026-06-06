const { normalizeBottleSize, isCanonicalCode, CANONICAL_CODES } = require('./bottleSizes');

describe('normalizeBottleSize', () => {
  test.each([
    ['750ml (Standard)', '750ml'],
    ['750ml（標準）', '750ml'],   // localized label suffix (Japanese)
    ['750ml', '750ml'],
    ['750 ml', '750ml'],
    ['1.5L (Magnum)', '1500ml'],
    ['3L (Double Magnum)', '3000ml'],
    ['1,5 l', '1500ml'],          // EU decimal comma
    ['0,75L', '750ml'],
    ['0.375', '375ml'],           // bare litres (< 20)
    ['620ml', '620ml'],           // Clavelin — kept as-is
    ['375ml (Half)', '375ml'],
    ['75cl', '750ml'],            // centilitres
    [750, '750ml'],               // bare number ml
    [1.5, '1500ml'],              // bare number litres
    ['', null],
    ['n/a', null],
    [null, null],
    [undefined, null],
  ])('%p → %p', (input, expected) => {
    expect(normalizeBottleSize(input)).toBe(expected);
  });
});

describe('isCanonicalCode', () => {
  test('accepts <int>ml', () => {
    expect(isCanonicalCode('750ml')).toBe(true);
    expect(isCanonicalCode('1500ml')).toBe(true);
  });
  test('rejects labels and junk', () => {
    expect(isCanonicalCode('750ml (Standard)')).toBe(false);
    expect(isCanonicalCode('1.5L')).toBe(false);
    expect(isCanonicalCode('')).toBe(false);
    expect(isCanonicalCode(null)).toBe(false);
  });
});

test('all canonical codes are themselves canonical and idempotent', () => {
  for (const code of CANONICAL_CODES) {
    expect(isCanonicalCode(code)).toBe(true);
    expect(normalizeBottleSize(code)).toBe(code);
  }
});
