/**
 * The canonical identity key and the label sweetness term (GitHub discussion
 * #1754): the term is the same suffix generateWineKey adds, absent it the key
 * is exactly what it always was, and the sibling prefix still matches a
 * suffixed key (the resolver's one-sided guard is what then decides).
 */
const { computeCanonicalKey, canonicalSiblingPrefix } = require('./wineIdentity');
const { SWEETNESS_KEY_MARK } = require('./normalize');

test('no term: the three-argument key, the empty option and the null term are one key', () => {
  const plain = computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen');
  expect(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', {})).toBe(plain);
  expect(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', { sweetness: null })).toBe(plain);
  expect(plain).not.toContain(SWEETNESS_KEY_MARK);
});

test('a term suffixes the key, so the Kabinett and the Kabinett trocken never share a canonical identity', () => {
  const plain = computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen');
  const trocken = computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', { sweetness: 'Trocken' });
  expect(trocken).toBe(`${plain}${SWEETNESS_KEY_MARK}trocken`);
  expect(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', { sweetness: 'Feinherb' })).not.toBe(trocken);
});

test('the sibling prefix is a prefix of the suffixed key too', () => {
  const prefix = canonicalSiblingPrefix('Riesling Kabinett', 'Weingut Keller');
  expect(computeCanonicalKey('Riesling Kabinett', 'Weingut Keller', 'Rheinhessen', { sweetness: 'Trocken' }).startsWith(prefix)).toBe(true);
});
