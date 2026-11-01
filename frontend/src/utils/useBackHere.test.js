import { backPlaceLabel, cellarListFrom } from './useBackHere';
import { validScope, keepKnownCellars } from './savedScope';

// The bottle page's back link takes only known page names from the router
// state, and looks their label up itself.
test('a handed-over place is a known page name, nothing else', () => {
  expect(backPlaceLabel('racks')).toEqual(['bottleDetail.backToRacks', 'Back to the racks']);
  expect(backPlaceLabel('statistics')[0]).toBe('bottleDetail.backToStatistics');
  expect(backPlaceLabel('cellar')[0]).toBe('bottleDetail.backToCellar');
  for (const odd of ['__proto__', 'constructor', 'toString', 'Back to the racks', '', null, undefined, 3]) {
    expect(backPlaceLabel(odd)).toBeNull();
  }
});

test('a remembered scope must start with this cellar and hold ids only', () => {
  expect(validScope(['c1', 'c2'], 'c1')).toEqual(['c1', 'c2']);
  expect(validScope(['c2', 'c1'], 'c1')).toEqual(['c1']);
  expect(validScope(['c1', 5], 'c1')).toEqual(['c1']);
  expect(validScope(null, 'c1')).toEqual(['c1']);
});

test('cellars the user no longer has drop out of a scope; this one stays', () => {
  const scope = ['c1', 'c2', 'gone'];
  expect(keepKnownCellars(scope, 'c1', [{ _id: 'c2' }])).toEqual(['c1', 'c2']);
  // Nothing gone: the same array back (no needless re-render or refetch).
  const kept = ['c1', 'c2'];
  expect(keepKnownCellars(kept, 'c1', [{ _id: 'c2' }])).toBe(kept);
});

// After Drink, Delete or Move the bottle page goes to the cellar list the visit
// started from — handed straight to the bottle, or through the vintage page.
test('the cellar list a visit started from is an in-app cellar path, handed either way', () => {
  expect(cellarListFrom({ backTo: '/cellars/c1', backFrom: 'cellar' })).toBe('/cellars/c1');
  expect(cellarListFrom({ fromVintage: '/cellars/c2/vintages/w1/2019', cellarList: '/cellars/c1' })).toBe('/cellars/c1');
  // Another page's back place is not a cellar list.
  expect(cellarListFrom({ backTo: '/cellars/c1/racks', backFrom: 'racks' })).toBeNull();
  expect(cellarListFrom({ backTo: '/statistics', backFrom: 'cellar' })).toBeNull();
  for (const odd of ['//evil.example/cellars/', '/cellars/\\evil.example','https://evil.example/cellars/c1', 5, null]) {
    expect(cellarListFrom({ cellarList: odd })).toBeNull();
  }
  expect(cellarListFrom(null)).toBeNull();
  expect(cellarListFrom({ returning: true })).toBeNull();
});
