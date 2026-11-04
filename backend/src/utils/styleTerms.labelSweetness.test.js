/**
 * The style guard reads the RECORD before the name (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * Label sweetness moved into WineDefinition.labelSweetness and the word is
 * leaving the names it used to ride in. The #1134 guard read names only, so it
 * would have gone blind on exactly the wines it was built for — a Mosel range
 * folding back onto one row. styleOf reads the field where the record carries
 * it, the name where it does not, and the classification rows of kind ripeness
 * beside any Prädikat the name states; conflictingStyleTerms takes the wine,
 * or still a bare name, so every caller keeps working.
 */
const { styleOf, statedStyle, sweetnessStated, conflictingStyleTerms } = require('./styleTerms');
const ops = require('../services/sweetnessOps');

const term = (name, scale = 'still') => ({ name, scale, band: 'dry', regulated: true });
afterEach(() => ops.primeSweetnessCache(null));

describe('styleOf', () => {
  test('a bare name reads as statedStyle always did, with no field term', () => {
    const fromName = statedStyle('Riesling Spätlese Trocken');
    const s = styleOf('Riesling Spätlese Trocken');
    expect([...s.pradikat]).toEqual([...fromName.pradikat]);
    expect([...s.sweetness]).toEqual([...fromName.sweetness]);
    expect(s.term).toBeNull();
  });

  test('a recorded term states the sweetness even when the name no longer does', () => {
    const s = styleOf({ name: 'Riesling Spätlese', labelSweetness: term('Trocken') });
    expect([...s.sweetness]).toEqual(['trocken']);
    expect(s.term).toBe('trocken');
    expect(s.termName).toBe('Trocken');
    expect([...s.pradikat]).toEqual(['spatlese']);
  });

  test('a word the name tokenizer leaves out still counts as a statement from the field', () => {
    // 'dry' is ambiguous in a NAME (Dry Creek Valley); the field is explicit.
    expect([...styleOf({ name: 'Chenin Blanc', labelSweetness: term('Medium Dry') }).sweetness]).toEqual(['medium dry']);
    expect([...styleOf({ name: 'Sekt', labelSweetness: term('Mild', 'sparkling') }).sweetness]).toEqual(['mild']);
  });

  test('an unpopulated ref the term table cannot name is not a statement: the name decides', () => {
    expect(styleOf({ name: 'Riesling Spätlese', labelSweetness: { _id: 'x' } }).sweetness.size).toBe(0);
    expect(styleOf({ name: 'Riesling Spätlese trocken', labelSweetness: { _id: 'x' } }).sweetness.has('trocken')).toBe(true);
    expect(styleOf({ name: 'Riesling Spätlese', labelSweetness: 'a'.repeat(24) }).sweetness.size).toBe(0);
  });

  test('an unpopulated ref IS a statement when the term table\'s in-memory copy is warm (the belt for a caller that forgot the populate)', () => {
    const id = 'a'.repeat(24);
    ops.primeSweetnessCache([{ _id: id, name: 'trocken', scale: 'still', band: 'dry', synonyms: [] }]);
    const s = styleOf({ name: 'Riesling Spätlese', labelSweetness: id });
    expect(s.term).toBe('trocken');
    expect(sweetnessStated({ name: 'Riesling Spätlese', labelSweetness: { toString: () => id } })).toBe(true);
  });

  test('a bare string is never the word — only a populated row or an id the table knows', () => {
    expect(styleOf({ name: 'Riesling Spätlese', labelSweetness: 'trocken' }).term).toBeNull();
    expect(sweetnessStated({ name: 'Riesling Spätlese', labelSweetness: 'Brut Nature' })).toBe(false);
  });

  test('the ripeness tier comes from the classification rows beside the name', () => {
    const s = styleOf({ name: 'Scharzhofberger Riesling', classifications: [{ name: 'Auslese', kind: 'ripeness' }, { name: 'VDP Grosse Lage', kind: 'vineyard_rank' }] });
    expect([...s.pradikat]).toEqual(['auslese']);
  });
});

describe('sweetnessStated', () => {
  test('true from the field or the name, false otherwise', () => {
    expect(sweetnessStated({ name: 'Riesling Spätlese' })).toBe(false);
    expect(sweetnessStated({ name: 'Riesling Spätlese', labelSweetness: term('Trocken') })).toBe(true);
    expect(sweetnessStated({ name: 'Riesling Spätlese trocken' })).toBe(true);
    expect(sweetnessStated('Brut Rosé')).toBe(true);
  });
});

describe('conflictingStyleTerms with records', () => {
  test('two records with different terms are two wines; the same term is one', () => {
    const a = { name: 'Riesling Spätlese', labelSweetness: term('Trocken') };
    const b = { name: 'Riesling Spätlese', labelSweetness: term('Halbtrocken') };
    expect(conflictingStyleTerms(a, b)).toMatch(/different label sweetness \(Trocken vs Halbtrocken\)/);
    expect(conflictingStyleTerms(a, { name: 'Riesling Spätlese', labelSweetness: term('trocken') })).toBeNull();
  });

  test('two records compare exactly: Brut Nature and Brut are two wines, which names alone could not tell', () => {
    const nature = { name: 'Rosé', labelSweetness: term('Brut Nature', 'sparkling') };
    const brut = { name: 'Rosé', labelSweetness: term('Brut', 'sparkling') };
    expect(conflictingStyleTerms(nature, brut)).toMatch(/Brut Nature vs Brut/);
    expect(conflictingStyleTerms('Brut Nature', 'Brut')).toBeNull(); // the name rule: a subset is one wine written two ways
  });

  test('a record against a name compares as two names do', () => {
    expect(conflictingStyleTerms({ name: 'Riesling Spätlese', labelSweetness: term('Trocken') }, 'Riesling Spätlese Feinherb')).toMatch(/different sweetness/);
    expect(conflictingStyleTerms({ name: 'Rosé', labelSweetness: term('Brut', 'sparkling') }, { name: 'Brut Rosé' })).toBeNull();
    expect(conflictingStyleTerms({ name: 'Riesling Spätlese', labelSweetness: term('Trocken') }, { name: 'Riesling Spätlese' })).toBeNull(); // one-sided is not a conflict
  });

  test('bare names keep today\'s verdicts', () => {
    expect(conflictingStyleTerms('Riesling Spätlese Trocken', 'Riesling Spätlese Feinherb')).toMatch(/different sweetness/);
    expect(conflictingStyleTerms('Riesling Kabinett', 'Riesling Auslese')).toMatch(/different Prädikat/);
    expect(conflictingStyleTerms('Brut', 'Brut Rosé')).toBeNull();
  });
});
