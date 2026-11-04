/**
 * Label sweetness in the identity keys (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * Once the word leaves the names, "Riesling Kabinett" with the term trocken
 * and the Kabinett without one share producer:name:appellation — under a
 * UNIQUE index. The term rides on the key as a suffix, ONLY when set: every
 * key without a term must stay byte-identical to what it always was (no stored
 * key moves), the suffix must be unreachable from plain text, and the slug —
 * built from the display name — must not move when the word changes place.
 */
const {
  generateWineKey, pendingWineKey, draftWineKey, generateWineSlug,
  normalizeSweetnessTerm, sweetnessKeySegment, appendSweetnessTerm, SWEETNESS_KEY_MARK,
} = require('./normalize');

describe('keys without a term are unchanged', () => {
  test('generateWineKey: no option, an empty option and a null term are one key', () => {
    const plain = generateWineKey('Clos des Papes', 'Paul Avril', 'Châteauneuf-du-Pape');
    expect(plain).toBe('paul avril:clos des papes:chateauneufdupape'); // the fold joins hyphenated words, as it always has
    expect(generateWineKey('Clos des Papes', 'Paul Avril', 'Châteauneuf-du-Pape', {})).toBe(plain);
    expect(generateWineKey('Clos des Papes', 'Paul Avril', 'Châteauneuf-du-Pape', { sweetness: null })).toBe(plain);
    expect(generateWineKey('Clos des Papes', 'Paul Avril', 'Châteauneuf-du-Pape', { sweetness: '' })).toBe(plain);
  });

  test('pendingWineKey and draftWineKey too', () => {
    expect(pendingWineKey('Riesling', 'u1', 'Mosel', { sweetness: null })).toBe(pendingWineKey('Riesling', 'u1', 'Mosel'));
    expect(draftWineKey('Riesling', 'Weingut X', 'u1', 'Mosel', {})).toBe(draftWineKey('Riesling', 'Weingut X', 'u1', 'Mosel'));
  });
});

describe('keys with a term', () => {
  test('the term is a suffix after the appellation, the normalised word — Kabinett and Kabinett trocken are two keys', () => {
    const plain = generateWineKey('Riesling Kabinett', 'Weingut X', 'Mosel');
    const trocken = generateWineKey('Riesling Kabinett', 'Weingut X', 'Mosel', { sweetness: 'Trocken' });
    expect(trocken).toBe(`${plain}${SWEETNESS_KEY_MARK}trocken`);
    expect(trocken).not.toBe(plain);
    expect(generateWineKey('Riesling Kabinett', 'Weingut X', 'Mosel', { sweetness: 'Halbtrocken' })).not.toBe(trocken);
  });

  test('ß and accents fold; a listed spelling keys the same as the word it spells only through the term row, not here', () => {
    expect(normalizeSweetnessTerm('Süß')).toBe('suss');
    expect(normalizeSweetnessTerm('Demi-Sec')).toBe('demisec'); // hyphens join, so "Demi Sec" is a synonym row, not the same key
    expect(normalizeSweetnessTerm('Demi Sec')).toBe('demi sec');
    expect(normalizeSweetnessTerm('Brut Zéro')).toBe('brut zero');
    expect(sweetnessKeySegment('Süß')).toBe('#sw=suss');
    expect(sweetnessKeySegment(null)).toBe('');
    expect(sweetnessKeySegment('   ')).toBe('');
  });

  test('the marker cannot be produced by a plain key: # and = never survive normalisation', () => {
    const forged = generateWineKey('Riesling Kabinett', 'Weingut X', 'Mosel #sw=trocken');
    expect(forged).not.toContain(SWEETNESS_KEY_MARK);
    expect(pendingWineKey('Riesling #sw=trocken', 'u1')).not.toContain(SWEETNESS_KEY_MARK);
  });

  test('the pending and draft namespaces carry the same suffix', () => {
    expect(pendingWineKey('Riesling', 'u1', 'Mosel', { sweetness: 'Trocken' })).toBe(`${pendingWineKey('Riesling', 'u1', 'Mosel')}#sw=trocken`);
    expect(draftWineKey('Riesling', 'Weingut X', 'u1', '', { sweetness: 'Brut Nature' })).toBe(`${draftWineKey('Riesling', 'Weingut X', 'u1', '')}#sw=brut nature`);
  });
});

describe('appendSweetnessTerm — the name as the label reads it', () => {
  test('appends the term, never twice, and tolerates a missing side', () => {
    expect(appendSweetnessTerm('Riesling Kabinett', 'Trocken')).toBe('Riesling Kabinett Trocken');
    expect(appendSweetnessTerm('Riesling Kabinett trocken', 'Trocken')).toBe('Riesling Kabinett trocken');
    expect(appendSweetnessTerm('Riesling Kabinett TROCKEN', 'trocken')).toBe('Riesling Kabinett TROCKEN');
    expect(appendSweetnessTerm('Brut Premier', 'Brut')).toBe('Brut Premier');
    expect(appendSweetnessTerm('Rosé', 'Brut Nature')).toBe('Rosé Brut Nature');
    expect(appendSweetnessTerm('Riesling', null)).toBe('Riesling');
    expect(appendSweetnessTerm('', 'Brut')).toBe('Brut');
  });

  test('a whole token only: "Trockenbeerenauslese" does not carry "trocken"', () => {
    expect(appendSweetnessTerm('Riesling Trockenbeerenauslese', 'Trocken')).toBe('Riesling Trockenbeerenauslese Trocken');
  });
});

describe('generateWineSlug from the display name', () => {
  test('a wine whose word moved from the name into the term keeps the slug it had', () => {
    expect(generateWineSlug('Riesling Kabinett', 'Weingut X', 'Trocken')).toBe(generateWineSlug('Riesling Kabinett Trocken', 'Weingut X'));
    expect(generateWineSlug('Riesling Kabinett', 'Weingut X', 'Trocken')).toBe('weingut-x-riesling-kabinett-trocken');
  });

  test('without a term the slug is what it always was', () => {
    expect(generateWineSlug('Riesling Kabinett Trocken', 'Weingut X', null)).toBe(generateWineSlug('Riesling Kabinett Trocken', 'Weingut X'));
    expect(generateWineSlug('Cloudy Bay Sauvignon Blanc', 'Cloudy Bay')).toBe('cloudy-bay-sauvignon-blanc');
  });
});
