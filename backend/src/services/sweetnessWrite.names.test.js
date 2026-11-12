/**
 * The label sweetness write rule reading NAMES: the cases where a careless
 * reading cuts the wrong word or the wrong amount.
 *
 * WHY THIS TEST EXISTS:
 * Each case below once gave a wrong name or a wrong term: a word in another
 * script deleted with the term beside it, a term joined by an en dash read as
 * half of itself, a modifier word ("Semi-", "halb", "Zéro Dosage") ignored, a
 * place name ("Arroyo Seco") cut, punctuation or characters left dangling, a
 * hostile name that took seconds to read, and spellings the style guard
 * already knows ("Suess", "Troken") read as nothing. Pinned against the real
 * seed table, without a database.
 */
const ops = require('./sweetnessOps');
const { extractLoaded, assignSweetness } = require('./sweetnessWrite');
const seed = require('../data/sweetness-terms.json');

const hex = (n) => n.toString(16).padStart(24, '0');
const ROWS = seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r }));
const row = (name, scale) => ROWS.find((r) => r.name === name && r.scale === scale);

let terms;
beforeEach(async () => { ops.primeSweetnessCache(ROWS); terms = await ops.loadTerms(); });
afterEach(() => ops.primeSweetnessCache(null));

const read = (name, scale, opts = {}) => extractLoaded(terms, name, { scale, ...opts });
const S = 'still';
const P = 'sparkling';

describe('a word the fold empties is never cut with the term', () => {
  test.each([
    ['Рислинг Сухое trocken', S, 'Рислинг Сухое', 'trocken'],
    ['Рислинг Brut Розе', P, 'Рислинг Розе', 'Brut'],
    ['甲州 スパークリング Brut', P, '甲州 スパークリング', 'Brut'],
    ['Cuvée Ø Brut', P, 'Cuvée Ø', 'Brut'],
  ])('%s → %s', (name, scale, kept, term) => {
    expect(read(name, scale)).toMatchObject({ name: kept, term: { name: term } });
  });
});

describe('every dash joins the words of one term', () => {
  test.each([
    ['Vouvray Demi–Sec', S, 'demi-sec'],
    ['Vouvray Demi—Sec', S, 'demi-sec'],
    ['Vouvray Demi−Sec', S, 'demi-sec'],
    ['Vouvray Demi­Sec', S, 'demi-sec'],
    ['Vouvray Demi​Sec', S, 'demi-sec'],
    ['Champagne Extra–Brut', P, 'Extra Brut'],
  ])('%s reads %s', (name, scale, term) => {
    expect(read(name, scale)).toMatchObject({ term: { name: term } });
  });

  test('a term glued to a neighbour by / . or \' is not read', () => {
    expect(read('Vouvray Demi/Sec', S)).toMatchObject({ name: 'Vouvray Demi/Sec', term: null, ambiguous: { kind: 'glued_word' } });
    expect(read('Vouvray Demi.Sec', S)).toMatchObject({ term: null, ambiguous: { kind: 'glued_word' } });
  });

  test('switch off: an en-dashed name is no contradiction of its own term', async () => {
    const wine = { name: 'Vouvray Demi–Sec', type: 'white' };
    const r = await assignSweetness(wine, { labelSweetness: 'demi-sec' });
    expect(r).toMatchObject({ ok: true, changed: true, review: null });
    expect(wine.labelSweetness).toBe(row('demi-sec', S)._id);
  });
});

describe('a word that changes the term beside it', () => {
  test.each([
    ['Lambrusco Semi-Secco', P],
    ['Riesling halb trocken', S],
    ['Champagne Ultra Brut', P],
    ['Cuvée Brut Extra Old', P],
  ])('%s is not read', (name, scale) => {
    expect(read(name, scale)).toMatchObject({ name, term: null, ambiguous: { kind: 'modifier' } });
  });

  test('"Zéro Dosage" is a spelling of Dosage Zéro, so a name with Brut beside it states two terms', () => {
    expect(read('Champagne Brut Zéro Dosage', P)).toMatchObject({ term: null, ambiguous: { kind: 'two_terms' } });
    expect(read('Champagne Zéro Dosage', P)).toMatchObject({ name: 'Champagne', term: { name: 'Dosage Zéro' } });
    expect(read('Champagne Non Dosé', P)).toMatchObject({ name: 'Champagne', term: { name: 'Pas Dosé' } });
  });
});

describe('a word that is also the wine\'s own place or producer', () => {
  test('"Arroyo Seco" in the appellation keeps its Seco', () => {
    expect(read('Riva Ranch Chardonnay Arroyo Seco', S, { places: ['Arroyo Seco'] }))
      .toMatchObject({ name: 'Riva Ranch Chardonnay Arroyo Seco', term: null, ambiguous: { kind: 'place_word' } });
  });

  test('through the write rule, from the wine\'s own fields', async () => {
    const constants = require('../config/constants');
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    try {
      const wine = { type: 'white', appellation: 'Arroyo Seco', producer: 'Riva Ranch' };
      const r = await assignSweetness(wine, { name: 'Riva Ranch Chardonnay Arroyo Seco' });
      expect(r).toMatchObject({ changed: false, ambiguous: { kind: 'place_word' }, review: { reason: 'name_ambiguous' } });
      expect(wine.labelSweetness).toBeUndefined();
    } finally {
      constants.SWEETNESS_EXTRACT_FROM_NAME = false;
    }
  });
});

describe('what a cut leaves', () => {
  test.each([
    ['Riesling "trocken"', S, 'Riesling'],
    ['Riesling „trocken“', S, 'Riesling'],
    ['Riesling »trocken«', S, 'Riesling'],
    ['Riesling trocken.', S, 'Riesling.'],
    ['Weißburgunder -S- trocken', S, 'Weißburgunder -S-'],
    ['Riesling-trocken', S, 'Riesling'],
    ['Brut-Rosé', P, 'Rosé'],
    ['Riesling - trocken', S, 'Riesling'],
    ['Cuvée, Brut, Rosé', P, 'Cuvée, Rosé'],
  ])('%s → %s', (name, scale, kept) => {
    expect(read(name, scale).name).toBe(kept);
  });

  test('a cut that would leave punctuation at an edge reads nothing', () => {
    expect(read('Brut & Rosé', P)).toMatchObject({ name: 'Brut & Rosé', term: null, ambiguous: { kind: 'untidy_cut' } });
  });

  test('the same term twice is not read ("Brut de Brut")', () => {
    expect(read('Brut de Brut', P)).toMatchObject({ name: 'Brut de Brut', term: null, ambiguous: { kind: 'two_terms' } });
  });

  test('a name with no letter left keeps the word ("Brut 2012")', () => {
    expect(read('Brut 2012', P)).toMatchObject({ name: 'Brut 2012', term: { name: 'Brut' } });
  });
});

describe('a hostile name is read in linear time', () => {
  const hostile = (n) => `x${' '.repeat(n - 6 - 5 * Math.floor(n / 25))}y${' Brut'.repeat(Math.floor(n / 25))}`;

  test('5,000 and 10,000 characters: answered at once, nothing read', async () => {
    for (const n of [5000, 10000]) {
      const name = hostile(n);
      const t0 = Date.now();
      const r = read(name, P);
      const w = await assignSweetness({}, { name, type: 'sparkling', labelSweetness: 'Brut' });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(r).toMatchObject({ name, term: null, ambiguous: { kind: 'too_long' } });
      expect(w.ok).toBe(true);
    }
  });

  test('a long run of spaces inside a readable name is cut in linear time', () => {
    const name = `Riesling${' '.repeat(280)}trocken`;
    const t0 = Date.now();
    expect(read(name, S)).toMatchObject({ name: 'Riesling', term: { name: 'trocken' } });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('spellings the style guard already knows', () => {
  test('"Suess" is süß and the observed "Troken" is trocken, in a name held against a term', async () => {
    const suess = { name: 'Riesling Suess', type: 'white' };
    expect(await assignSweetness(suess, { labelSweetness: 'trocken' })).toMatchObject({ changed: false, review: { reason: 'term_contradiction' } });
    const troken = { name: 'Riesling Troken', type: 'white' };
    expect(await assignSweetness(troken, { labelSweetness: 'halbtrocken' })).toMatchObject({ changed: false, review: { reason: 'term_contradiction' } });
    expect(read('Riesling Troken', S)).toMatchObject({ name: 'Riesling', term: { name: 'trocken' } });
  });
});
