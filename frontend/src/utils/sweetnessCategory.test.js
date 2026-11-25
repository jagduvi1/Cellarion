import {
  SWEETNESS_CATEGORIES, SWEETNESS_NOT_STATED, SWEETNESS_FILTER_VALUES,
  sweetnessFilterLabel, sweetnessChipLabel, sweetnessFilterValueOf,
} from './sweetnessCategory';

// The sweetness category on the screens. The server works it out; here are
// only the values the filter offers, their names, and what the offline copy
// matches a wine on — which must be what the server's filter matches it on
// (backend services/sweetnessCategory sweetnessFilterValue), or a cellar
// would list different bottles offline than online.

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

test('the filter offers the four categories in scale order, then the wines that state none', () => {
  expect(SWEETNESS_CATEGORIES).toEqual(['dry', 'off-dry', 'medium-sweet', 'sweet']);
  expect(SWEETNESS_FILTER_VALUES).toEqual([...SWEETNESS_CATEGORIES, SWEETNESS_NOT_STATED]);
});

test('"not stated" says of what on a chip, which stands alone', () => {
  expect(sweetnessFilterLabel(t, SWEETNESS_NOT_STATED)).toBe('Not stated');
  expect(sweetnessChipLabel(t, SWEETNESS_NOT_STATED)).toBe('Sweetness not stated');
  expect(sweetnessChipLabel(t, 'dry')).toBe(sweetnessFilterLabel(t, 'dry'));
});

describe('what the offline filter matches a wine on', () => {
  test('its category, or "not-stated" for a wine that could state one and does not', () => {
    expect(sweetnessFilterValueOf({ type: 'white', sweetnessCategory: 'off-dry' })).toBe('off-dry');
    expect(sweetnessFilterValueOf({ type: 'white', sweetnessCategory: null })).toBe('not-stated');
    expect(sweetnessFilterValueOf({ type: null, sweetnessCategory: null })).toBe('not-stated');
  });

  test('nothing for a fortified wine, a drink that is not wine and a bottle without a wine', () => {
    expect(sweetnessFilterValueOf({ type: 'fortified', sweetnessCategory: null })).toBe('');
    expect(sweetnessFilterValueOf({ nonWine: true, type: null, sweetnessCategory: null })).toBe('');
    expect(sweetnessFilterValueOf(null)).toBe('');
    expect(sweetnessFilterValueOf('w1')).toBe('');
  });

  test('nothing for a wine from a copy saved before the category was sent', () => {
    expect(sweetnessFilterValueOf({ type: 'white', name: 'Riesling trocken' })).toBe('');
  });
});
