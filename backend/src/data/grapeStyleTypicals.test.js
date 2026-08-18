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

test('tannin axis works the same way — a high-tannin Pinot Noir fires', () => {
  expect(check(['Pinot Noir'], { tannin: 'high' })).toMatch(/pinot noir is defined by low tannin/);
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
