/**
 * utils/imageVintage.photoVintage — the vintage a photo is filed under
 * (support ticket 2026-10-09). A photo is of ONE bottle, so it takes that
 * bottle's vintage; years nobody knows carry nothing worth matching on.
 */
const { photoVintage } = require('./imageVintage');

test('a real vintage and NV are kept as the bottle stores them', () => {
  expect(photoVintage('2015')).toBe('2015');
  expect(photoVintage(' 2015 ')).toBe('2015');
  expect(photoVintage('NV')).toBe('NV');
  expect(photoVintage(2019)).toBe('2019');
});

test('unknown, empty and absurd values file the photo wine-wide (null)', () => {
  expect(photoVintage('Unknown')).toBeNull();
  expect(photoVintage('unknown')).toBeNull();
  expect(photoVintage('')).toBeNull();
  expect(photoVintage('   ')).toBeNull();
  expect(photoVintage(null)).toBeNull();
  expect(photoVintage(undefined)).toBeNull();
  expect(photoVintage('x'.repeat(11))).toBeNull();
});

const { pickVintageOfficials, vintageOfficialOrder, vintageKey } = require('./imageVintage');

/**
 * The photo a vintage shows (support ticket 2026-10-09): an admin's choice,
 * else the wine's official image when it is of that vintage, else the FIRST
 * one approved — a later upload never silently replaces it.
 */
describe('pickVintageOfficials', () => {
  const row = (id, wine, vintage, over = {}) => ({ _id: id, wineDefinition: wine, vintage, createdAt: '2026-03-01T00:00:00Z', ...over });

  test('the first approved photo of each wine + vintage, kept apart per vintage and per wine', () => {
    const picked = pickVintageOfficials([
      row('b', 'w1', '2016', { createdAt: '2026-05-01T00:00:00Z' }),
      row('a', 'w1', '2016', { createdAt: '2026-02-01T00:00:00Z' }),
      row('c', 'w1', '2015'),
      row('d', 'w2', '2016'),
    ]);
    expect(picked.get(vintageKey('w1', '2016'))._id).toBe('a');
    expect(picked.get(vintageKey('w1', '2015'))._id).toBe('c');
    expect(picked.get(vintageKey('w2', '2016'))._id).toBe('d');
    expect(picked.size).toBe(3);
  });

  test('an admin\'s choice beats the wine\'s official image, which beats the first approved', () => {
    const first = row('first', 'w1', '2016', { createdAt: '2026-01-01T00:00:00Z' });
    const wineOfficial = row('wineOfficial', 'w1', '2016', { assignedToWine: true });
    const chosen = row('chosen', 'w1', '2016', { assignedToVintage: true, createdAt: '2026-09-01T00:00:00Z' });
    expect(pickVintageOfficials([first, wineOfficial]).get(vintageKey('w1', '2016'))._id).toBe('wineOfficial');
    expect(pickVintageOfficials([first, wineOfficial, chosen]).get(vintageKey('w1', '2016'))._id).toBe('chosen');
    expect([first, chosen, wineOfficial].sort(vintageOfficialOrder).map((r) => r._id)).toEqual(['chosen', 'wineOfficial', 'first']);
  });

  test('rows without a wine or a usable vintage are skipped; a populated wine reference works', () => {
    const picked = pickVintageOfficials([
      row('x', null, '2016'),
      row('y', 'w1', 'Unknown'),
      row('z', 'w1', null),
      row('p', { _id: 'w9', name: 'Populated' }, 'NV'),
    ]);
    expect([...picked.keys()]).toEqual([vintageKey('w9', 'NV')]);
  });
});
