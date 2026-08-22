/**
 * findGrapeStyleConflict — the deterministic half of the regional-prior
 * defence (ticket 6a8464ea phase 2). Precision IS the feature: only an
 * opposite extreme on a wine whose grapes ALL assert it may ever fire.
 */
const { findGrapeStyleConflict, GRAPE_STYLE_TYPICALS } = require('./grapeStyleTypicals');
const { normalizeString } = require('../utils/normalize');

const check = (grapes, profile) => findGrapeStyleConflict(grapes, profile, normalizeString);

test('the ticket case: a high-acidity Bacchus fires', () => {
  expect(check(['Bacchus'], { acidity: 'high' })).toMatch(/bacchus is defined by low acidity/);
});

test('the agreeing extreme never fires — Riesling IS high-acid', () => {
  expect(check(['Riesling'], { acidity: 'high' })).toBeNull();
});

test('medium never conflicts with anything', () => {
  expect(check(['Bacchus'], { acidity: 'medium' })).toBeNull();
  expect(check(['Nebbiolo'], { tannin: 'medium' })).toBeNull();
});

test('a grape not in the table is simply not checked', () => {
  expect(check(['Chardonnay'], { acidity: 'high', tannin: 'high' })).toBeNull();
});

test('a blend fires only when EVERY grape asserts the opposite extreme', () => {
  // Gewürztraminer asserts low acidity, Chardonnay asserts nothing → skip.
  expect(check(['Gewürztraminer', 'Chardonnay'], { acidity: 'high' })).toBeNull();
  // Both assert low → a high-acidity profile is diagnostic.
  expect(check(['Gewürztraminer', 'Viognier'], { acidity: 'high' })).toMatch(/defined by low acidity/);
});

test('tannin axis works the same way — a low-tannin Nebbiolo fires', () => {
  expect(check(['Nebbiolo'], { tannin: 'low' })).toMatch(/nebbiolo is defined by high tannin/);
});

// ---------------------------------------------------------------------------
// The false positive, and the invariant that stops it coming back.
// Until 2026-08-22 the assertion directly above this block read
//   check(['Pinot Noir'], { tannin: 'high' })  →  fires
// which is to say the suite asserted the bug as correct behaviour and then
// protected it. It fired twice in production, on two correct Pommards.
// ---------------------------------------------------------------------------
describe('no variety is defined by LOW tannin (somm ticket 6a896b7e)', () => {
  test('a high-tannin Pinot Noir is silent — that is Pommard, not an error', () => {
    expect(check(['Pinot Noir'], { tannin: 'high' })).toBeNull();
  });

  test('the appellations that actually own this: firm Pinot is normal', () => {
    // Nuits-Saint-Georges, Gevrey-Chambertin, Corton and Central Otago all
    // hold single-variety Pinot in this registry; every one of them is
    // legitimately capable of high tannin.
    for (const profile of [{ tannin: 'high' }, { tannin: 'medium' }, { tannin: 'low' }]) {
      expect(check(['Pinot Noir'], profile)).toBeNull();
    }
  });

  test('Gamay too — cru Beaujolais is structured on purpose', () => {
    expect(check(['Gamay'], { tannin: 'high' })).toBeNull();
  });

  test('INVARIANT: the table may never assert tannin: low for any variety', () => {
    // Acidity is grape chemistry and high tannin has a skin-chemistry floor,
    // so both are assertable. Low tannin is a ceiling the winemaker sets —
    // extraction, whole-cluster and oak carry thin-skinned varieties past it
    // routinely. An entry here would flag correct data, as Pinot Noir did.
    const offenders = Object.entries(GRAPE_STYLE_TYPICALS)
      .filter(([, spec]) => spec.tannin === 'low')
      .map(([grape]) => grape);
    expect(offenders).toEqual([]);
  });

  test('high-tannin entries are still asserted — the rule keeps its teeth', () => {
    const highTannin = Object.entries(GRAPE_STYLE_TYPICALS)
      .filter(([, spec]) => spec.tannin === 'high')
      .map(([grape]) => grape);
    expect(highTannin).toEqual(expect.arrayContaining(['nebbiolo', 'tannat', 'sagrantino']));
  });

  test('the acidity axis is untouched by all of this', () => {
    expect(check(['Bacchus'], { acidity: 'high' })).toMatch(/defined by low acidity/);
    expect(check(['Riesling'], { acidity: 'low' })).toMatch(/defined by high acidity/);
  });
});

test('accent folding matches the table key', () => {
  expect(check(['Gewürztraminer'], { acidity: 'high' })).toMatch(/gewurztraminer/);
});

test('no grapes, null values, empty input — all silent', () => {
  expect(check([], { acidity: 'high' })).toBeNull();
  expect(check(['Bacchus'], { acidity: null })).toBeNull();
  expect(check(['Bacchus'], {})).toBeNull();
});

test('every table entry asserts only structural extremes, never medium', () => {
  for (const [grape, spec] of Object.entries(GRAPE_STYLE_TYPICALS)) {
    for (const [axis, v] of Object.entries(spec)) {
      expect(['low', 'high']).toContain(v);
      expect(['acidity', 'tannin']).toContain(axis);
      expect(grape).toBe(grape.toLowerCase());
    }
  }
});
