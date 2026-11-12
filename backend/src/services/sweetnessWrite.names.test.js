/**
 * The label sweetness write rule reading NAMES: the cases where a careless
 * reading cuts the wrong word or the wrong amount.
 *
 * WHY THIS TEST EXISTS:
 * Each case below once gave a wrong name or a wrong term: a word in another
 * script deleted with the term beside it, a term joined by an en dash read as
 * half of itself, a modifier word ("Semi-", "halb", "Sans Dosage") ignored,
 * a place name ("Arroyo Seco") cut, punctuation or characters left dangling,
 * a neighbour's quote or an abbreviation's period taken with the term, a
 * hostile name that took seconds to read, and spellings the style guard
 * already knows ("Suess", "Troken") read as nothing. Pinned against the real
 * seed table, without a database; the generated names pin what a cut may
 * take: never a letter or digit of the rest of the name.
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
    ['Vouvray Demi\u2013Sec', S, 'demi-sec'],
    ['Vouvray Demi\u2014Sec', S, 'demi-sec'],
    ['Vouvray Demi\u2212Sec', S, 'demi-sec'],
    ['Vouvray Demi\u00ADSec', S, 'demi-sec'],
    ['Vouvray Demi\u200BSec', S, 'demi-sec'],
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

describe('a word of two scripts is one word, never part of a term', () => {
  test.each([
    ['Cuvée 甲州Brut Rosé', P],
    ['Cuvée ØBrut Rosé', P],
    ['Riesling 辛口trocken', S],
  ])('%s keeps every letter, nothing read', (name, scale) => {
    expect(read(name, scale)).toMatchObject({ name, term: null });
  });

  test('what such a word says still counts beside a term: "ØExtra Brut" is not Brut', () => {
    expect(read('Cuvée ØExtra Brut', P)).toMatchObject({ name: 'Cuvée ØExtra Brut', term: null, ambiguous: { kind: 'modifier' } });
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

  test('"dosage" beside the term, or one word further ("Brut Sans Dosage"), changes it; "Sans Année" does not', () => {
    expect(read('Champagne Brut Dosage Réduit', P)).toMatchObject({ term: null, ambiguous: { kind: 'modifier' } });
    expect(read('Champagne Brut Sans Dosage', P)).toMatchObject({ name: 'Champagne Brut Sans Dosage', term: null, ambiguous: { kind: 'modifier' } });
    expect(read('Champagne Brut 0 Dosage', P)).toMatchObject({ term: null, ambiguous: { kind: 'modifier' } });
    expect(read('Champagne Brut Sans Année', P)).toMatchObject({ name: 'Champagne Sans Année', term: { name: 'Brut' } });
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

  test.each([
    ['the appellation, with a dash', { places: ['Arroyo-Seco'] }],
    ['the appellation, with a double space and a suffix', { places: ['arroyo  seco AVA'] }],
    ['the region, given as a string', { places: 'Arroyo Seco' }],
    ['a region row { name }', { places: [null, 42, { name: 'Arroyo Seco' }] }],
  ])('%s', (label, opts) => {
    expect(read('Riva Ranch Chardonnay Arroyo Seco', S, opts)).toMatchObject({ term: null, ambiguous: { kind: 'place_word' } });
  });

  test('a word of a place the wine is not from is still read', () => {
    expect(read('Riva Ranch Chardonnay Arroyo Seco', S, { places: ['Monterey'] })).toMatchObject({ name: 'Riva Ranch Chardonnay Arroyo', term: { name: 'seco' } });
  });

  test.each([
    ['its region, populated', { region: { _id: hex(5), name: 'Arroyo Seco' } }, 'Chardonnay Arroyo Seco'],
    ['its producer', { producer: 'Tenuta Colle Secco' }, 'Rosso Colle Secco'],
    ['its appellation', { appellation: 'Arroyo Seco' }, 'Chardonnay Arroyo Seco'],
  ])('through the write rule, from %s', async (label, fields, name) => {
    const constants = require('../config/constants');
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    try {
      const wine = { type: name.startsWith('Rosso') ? 'red' : 'white', ...fields };
      const r = await assignSweetness(wine, { name });
      expect(r).toMatchObject({ changed: false, ambiguous: { kind: 'place_word' }, review: { reason: 'name_ambiguous' } });
      expect(wine.labelSweetness).toBeUndefined();
    } finally {
      constants.SWEETNESS_EXTRACT_FROM_NAME = false;
    }
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
    // A quote that belongs to a neighbour keeps its space.
    ['Sekt "Alte Reben" Brut Rosé', P, 'Sekt "Alte Reben" Rosé'],
    ['Cuvée Brut "Rosé"', P, 'Cuvée "Rosé"'],
    ['Riesling Brut «Réserve»', P, 'Riesling «Réserve»'],
    ['Cuvée "Brut Rosé"', P, 'Cuvée "Rosé"'],
    // An abbreviation keeps its period; a dash or comma left at the edge goes.
    ['R.D. Extra Brut', P, 'R.D.'],
    ['Sekt b.A. Brut', P, 'Sekt b.A.'],
    ['Riesling Q.b.A. trocken', S, 'Riesling Q.b.A.'],
    ['Riesling- trocken', S, 'Riesling'],
    ['N.V. Brut.', P, 'N.V.'],
    ['Riesling, trocken.', S, 'Riesling.'],
    // Between two words a term glued, one dash stays; a doubled separator is one.
    ['Pinot-Brut-Rosé', P, 'Pinot-Rosé'],
    ['Cuvée & Brut & Rosé', P, 'Cuvée & Rosé'],
    ['Cuvée - Brut - Rosé', P, 'Cuvée - Rosé'],
    // A comma inside a bracket parted the term from the next item.
    ['Rosé (Brut, Magnum)', P, 'Rosé (Magnum)'],
    ['Rosé (Magnum, Brut)', P, 'Rosé (Magnum)'],
    // A comma on the word before says what a separator after would say twice.
    ['Cuvée, Brut - Rosé', P, 'Cuvée, Rosé'],
    ['Cuvée; Brut – Rosé', P, 'Cuvée; Rosé'],
    ['Cuvée (Magnum), Brut / Rosé', P, 'Cuvée (Magnum), Rosé'],
    // A pair holding the term and its punctuation goes whole; „…” is a pair too.
    ['Cuvée "Brut," Rosé', P, 'Cuvée Rosé'],
    ['Cuvée (Brut.) Rosé', P, 'Cuvée Rosé'],
    ['Cuvée „Brut” Rosé', P, 'Cuvée Rosé'],
    // A pair standing apart around the term is emptied too.
    ['Cuvée " Brut " Rosé', P, 'Cuvée Rosé'],
    ['Riesling « trocken »', S, 'Riesling'],
    ['Riesling ( trocken )', S, 'Riesling'],
    ['Cuvée "Brut "Rosé', P, 'Cuvée Rosé'],
    ['"Brut "(Magnum)', P, '(Magnum)'],
    // A comma or colon glued between the term and its only neighbour; of two, one stays.
    ['Riesling,trocken', S, 'Riesling'],
    ['Riesling:trocken', S, 'Riesling'],
    ['Cuvée,Brut,Rosé', P, 'Cuvée,Rosé'],
    // A separator inside a bracket, or beside a comma, parted the term from one neighbour only.
    ['Cuvée - Brut, Rosé', P, 'Cuvée - Rosé'],
    ['Cuvée (Brut - Rosé)', P, 'Cuvée (Rosé)'],
    ['(Rosé - Brut) Cuvée', P, '(Rosé) Cuvée'],
  ])('%s → %s', (name, scale, kept) => {
    expect(read(name, scale).name).toBe(kept);
  });

  test.each([
    ['Brut & Rosé', P],
    ['Sekt (Brut', P],
    ['Riesling . trocken', S],
    ['Cuvée( Brut )Rosé', P],
    ['Cuvée »Brut) Rosé', P],
    ['Cuvée (Brut« Rosé', P],
    ['Cuvée "Brut - ""Rosé"', P],
    ['Cuvée - Brut / Rosé', P],
  ])('%s: a cut it cannot tidy reads nothing and removes nothing', (name, scale) => {
    expect(read(name, scale)).toMatchObject({ name, term: null, ambiguous: { kind: 'untidy_cut' } });
  });

  test('the same term twice is not read ("Brut de Brut")', () => {
    expect(read('Brut de Brut', P)).toMatchObject({ name: 'Brut de Brut', term: null, ambiguous: { kind: 'two_terms' } });
  });

  test('a name with no letter left keeps the word ("Brut 2012")', () => {
    expect(read('Brut 2012', P)).toMatchObject({ name: 'Brut 2012', term: { name: 'Brut' } });
  });
});

describe('a cut keeps every letter and digit of the rest of the name, in order', () => {
  const lefts = ['', 'Cuvée', 'R.D.', 'Sekt "Alte Reben"', 'Rosé (Magnum', 'N.V.', 'Riesling-', '-S-', 'No. 5', 'Cuvée,'];
  const gapsL = [' ', '-', ' - ', ', ', ' & ', ' (', ' "', '(', ' «', '"'];
  const gapsR = ['', ' ', '-', ' - ', ', ', ')', '"', '.', ' & ', '»', ')Rosé', '. '];
  const rights = ['', 'Rosé', '(Magnum)', '"Rosé"', 'No. 5', '-S-', 'Rosé.'];
  const letters = (s) => [...s].filter((c) => /[\p{L}\p{N}]/u.test(c)).join('');
  const bare = (s) => s.replace(/\s+/g, '');
  const within = (small, big) => { let i = 0; for (const c of big) if (c === small[i]) i += 1; return i === small.length; };

  test('every generated name: read with nothing added and nothing of the rest lost, or not read and unchanged', () => {
    let cut = 0; let untidy = 0;
    for (const l of lefts) for (const gl of gapsL) for (const gr of gapsR) for (const r of rights) {
      const name = `${l}${gl}Brut${gr}${r}`;
      const out = read(name, P);
      if (out.ambiguous && out.ambiguous.kind === 'untidy_cut') {
        untidy += 1;
        expect(out.name).toBe(name);
        continue;
      }
      if (!out.term || out.name === name) continue; // read, and no letter left: the name stays
      cut += 1;
      const rest = name.replace('Brut', ' ');
      expect([name, letters(out.name)]).toEqual([name, letters(rest)]);
      expect([name, within(bare(out.name), bare(rest))]).toEqual([name, true]);
    }
    expect(cut).toBeGreaterThan(2000);
    expect(untidy).toBeGreaterThan(3000);
  });
});

describe('a hostile name is read in linear time', () => {
  const hostile = (n) => `x${' '.repeat(n - 6 - 5 * Math.floor(n / 25))}y${' Brut'.repeat(Math.floor(n / 25))}`;

  test('a name over 300 characters is not read: 5,000 and 10,000 characters answered at once', async () => {
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

  test('the cut itself, on 100,000-character runs of spaces and punctuation around the term', () => {
    const { cutSpan } = require('./sweetnessWrite').__testing;
    const n = 100000;
    const shapes = [
      [`x${' '.repeat(n)}Brut${' '.repeat(n)}y`, 'x y'],
      [`x${' '.repeat(n)}Brut`, 'x'],
      [`Brut${' '.repeat(n)}y`, 'y'],
      [`x${'('.repeat(n)}Brut${')'.repeat(n)}y`, 'x y'],
      [`x ${'-'.repeat(n)} Brut`, 'x'],
      [`x${', '.repeat(n)}Brut${' ,'.repeat(n)}`, null],
      [`x${','.repeat(n)} Brut`, 'x'],
      // A run of spaces with punctuation after it: a trailing-space pattern would
      // backtrack over the run from every position.
      [`x${' '.repeat(n)}, Brut`, null],
      [`Brut ,${' '.repeat(n)}y`, null],
      [`x${' '.repeat(n)}- Brut`, 'x'],
    ];
    const t0 = Date.now();
    const out = shapes.map(([text]) => { const at = text.indexOf('Brut'); return cutSpan(text, at, at + 4); });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).toEqual(shapes.map(([, kept]) => kept));
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
