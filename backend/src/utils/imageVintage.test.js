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
