const { buildSurfaceForms, inferGrapeIds } = require('./grapeInference');
const { normalizeString } = require('../utils/normalize');

// Synthetic grape corpus covering every trap: substring pairs (Cabernet
// Sauvignon vs Sauvignon Blanc, Pinot Noir/Gris/Blanc), a global-synonym grape
// (Syrah←shiraz, Zinfandel←primitivo), and a mono-varietal-appellation grape
// (Nebbiolo). Grape ids are the canonical name for readable assertions.
const CORPUS = [
  'Pinot Noir', 'Pinot Gris', 'Pinot Blanc', 'Chardonnay', 'Riesling',
  'Cabernet Sauvignon', 'Cabernet Franc', 'Sauvignon Blanc', 'Merlot',
  'Syrah', 'Zinfandel', 'Nebbiolo', 'Malbec', 'Sangiovese',
].map((name) => ({ _id: name, name, normalizedName: normalizeString(name), normalizedSynonyms: [] }));

const FORMS = buildSurfaceForms(CORPUS);
const infer = (name, appellation) => inferGrapeIds(name, appellation || '', FORMS).map(String);

describe('grape inference — the substring traps (must not double- or mis-tag)', () => {
  test('"Cabernet Sauvignon" tags ONLY Cabernet Sauvignon, never Sauvignon Blanc', () => {
    // The bare "sauvignon" → Sauvignon Blanc global synonym must not also fire.
    expect(infer('Château Whatever Cabernet Sauvignon')).toEqual(['Cabernet Sauvignon']);
  });

  test('a real blend tags both varieties', () => {
    expect(infer('Cabernet Sauvignon Merlot').sort()).toEqual(['Cabernet Sauvignon', 'Merlot']);
  });

  test('Pinot Noir / Gris / Blanc are never confused for one another', () => {
    expect(infer('Felton Road Block 3 Pinot Noir')).toEqual(['Pinot Noir']);
    expect(infer('Alsace Pinot Gris')).toEqual(['Pinot Gris']);
    expect(infer('Pinot Blanc')).toEqual(['Pinot Blanc']);
  });

  test('Cabernet Franc is not tagged as Cabernet Sauvignon', () => {
    expect(infer('Loire Cabernet Franc')).toEqual(['Cabernet Franc']);
  });
});

describe('grape inference — the Felton Road cases from the ticket', () => {
  test.each([
    ['Felton Road Bannockburn Chardonnay', ['Chardonnay']],
    ['Felton Road Block 1 Riesling', ['Riesling']],
    ['Felton Road Block 5 Pinot Noir', ['Pinot Noir']],
    ['Felton Road Cornish Point Pinot Noir', ['Pinot Noir']],
  ])('%s → %j', (name, expected) => {
    expect(infer(name)).toEqual(expected);
  });
});

describe('grape inference — global synonyms resolve to canonical', () => {
  test('Shiraz → Syrah', () => expect(infer('Barossa Shiraz')).toEqual(['Syrah']));
  test('Primitivo → Zinfandel', () => expect(infer('Primitivo di Manduria')).toEqual(['Zinfandel']));
});

describe('grape inference — mono-varietal appellation fallback', () => {
  test('name has no grape, appellation "Barolo" → Nebbiolo', () => {
    expect(infer('Riserva', 'Barolo')).toEqual(['Nebbiolo']);
  });
  test('tier suffix is stripped: "Barolo DOCG" → Nebbiolo', () => {
    expect(infer('Riserva', 'Barolo DOCG')).toEqual(['Nebbiolo']);
  });
  test('name inference wins over the appellation fallback', () => {
    // A (contrived) Barolo-appellation wine whose name names a different grape
    // still trusts the name, not the appellation.
    expect(infer('Chardonnay', 'Barolo')).toEqual(['Chardonnay']);
  });
  test('non-mono-varietal appellations do NOT infer (Rioja is a blend / white Viura)', () => {
    expect(infer('Reserva', 'Rioja')).toEqual([]);
    expect(infer('Rouge', 'Sancerre')).toEqual([]);
  });
});

describe('grape inference — no false positives', () => {
  test('a short synonym ("cot" → Malbec) never matches a substring', () => {
    // "cot" is below MIN_FORM_LEN, so "Apricot" must not tag Malbec.
    expect(infer('Apricot Dessert Wine')).toEqual([]);
  });
  test('a name with no known varietal returns nothing', () => {
    expect(infer('House Red Blend', 'Vin de France')).toEqual([]);
  });
  test('Malbec is still tagged when it is the actual word', () => {
    expect(infer('Cahors Malbec')).toEqual(['Malbec']);
  });
});
