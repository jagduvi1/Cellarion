/**
 * The sweetness facet value the cellar search keeps per wine
 * (services/bottleSearch sweetnessFacetOf).
 *
 * WHY THIS TEST EXISTS:
 * A plain cellar page counts every wine of the cellar on every page of its
 * scroll, and reading a name is the costly part of that. The value is
 * therefore kept — which is only right while what it was read from stands:
 * the same wine in the same state, against the same copy of the term table.
 * A wine that was saved since, or a term table read anew, must be read again;
 * a kept value outliving either would count a wine under a sweetness it no
 * longer has.
 */
const ops = require('./sweetnessOps');
const { _internal } = require('./bottleSearch');
const seed = require('../data/sweetness-terms.json');

const hex = (n) => n.toString(16).padStart(24, '0');
const ROWS = seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r }));
const SAVED = new Date('2026-01-01T00:00:00Z');
const wine = (over = {}) => ({ _id: hex(900), name: 'Riesling trocken', type: 'white', updatedAt: SAVED, ...over });

let terms;
beforeEach(async () => { ops.primeSweetnessCache(ROWS); terms = await ops.loadTerms(); _internal.forgetSweetnessFacets(); });
afterEach(() => ops.primeSweetnessCache(null));

test('the same wine in the same state is read once for a copy of the term table', () => {
  expect(_internal.sweetnessFacetOf(wine(), terms)).toBe('dry');
  // Nothing says the wine changed: the kept value stands, whatever this copy holds.
  expect(_internal.sweetnessFacetOf(wine({ name: 'Riesling feinherb' }), terms)).toBe('dry');
});

test('a wine saved since is read again', () => {
  expect(_internal.sweetnessFacetOf(wine(), terms)).toBe('dry');
  const later = wine({ name: 'Riesling feinherb', updatedAt: new Date(SAVED.getTime() + 1000) });
  expect(_internal.sweetnessFacetOf(later, terms)).toBe('off-dry');
});

test('a term table read anew is asked again', async () => {
  expect(_internal.sweetnessFacetOf(wine(), terms)).toBe('dry');
  ops.primeSweetnessCache(ROWS);
  const fresh = await ops.loadTerms();
  expect(fresh).not.toBe(terms);
  expect(_internal.sweetnessFacetOf(wine({ name: 'Riesling feinherb' }), fresh)).toBe('off-dry');
});

test('each wine has its own value, and a wine with no scale keeps none', () => {
  expect(_internal.sweetnessFacetOf(wine({ _id: hex(901), name: 'Riesling Kabinett' }), terms)).toBe('not-stated');
  expect(_internal.sweetnessFacetOf(wine({ _id: hex(902), name: 'Tawny', type: 'fortified' }), terms)).toBe('');
  expect(_internal.sweetnessFacetOf(wine(), terms)).toBe('dry');
});
