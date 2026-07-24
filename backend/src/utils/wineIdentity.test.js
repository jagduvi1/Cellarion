const { computeCanonicalKey, canonicalSiblingPrefix } = require('./wineIdentity');

describe('computeCanonicalKey', () => {
  test('collapses all three variance axes to one key — the July-2026 duplicate shape', () => {
    const canonical = computeCanonicalKey('Block 3 Pinot Noir', 'Felton Road', 'Bannockburn');
    expect(canonical).toBe('felton road:block 3 pinot noir:bannockburn');
    // producer variant + producer-in-name embed → SAME key
    expect(computeCanonicalKey('Felton Road Block 3 Pinot Noir', 'Felton Road Wines Ltd', 'Bannockburn'))
      .toBe(canonical);
  });

  test('appellation tier suffixes collapse', () => {
    expect(computeCanonicalKey('Barolo', 'Rossi', 'Barolo DOCG'))
      .toBe(computeCanonicalKey('Barolo', 'Rossi', 'Barolo'));
  });

  test('different appellations stay distinct — the Garden Spritz two-winery shape', () => {
    expect(computeCanonicalKey('Garden Spritz', 'Domaine Chandon', 'Napa Valley'))
      .not.toBe(computeCanonicalKey('Garden Spritz', 'Bodegas Chandon', 'Mendoza'));
  });

  test('missing appellation → empty third segment; empty inputs stay well-formed', () => {
    expect(computeCanonicalKey('X', 'Y')).toBe('y:x:');
    expect(computeCanonicalKey('', '')).toBe('::');
    expect(computeCanonicalKey('X', 'Y', null)).toBe('y:x:');
  });
});

describe('canonicalSiblingPrefix', () => {
  test('prefixes the full key of the same identity under ANY appellation', () => {
    const prefix = canonicalSiblingPrefix('Felton Road Block 3 Pinot Noir', 'Felton Road Wines Ltd');
    expect(prefix).toBe('felton road:block 3 pinot noir:');
    expect(computeCanonicalKey('Block 3 Pinot Noir', 'Felton Road', 'Central Otago').startsWith(prefix)).toBe(true);
    expect(computeCanonicalKey('Block 3 Pinot Noir', 'Felton Road').startsWith(prefix)).toBe(true);
  });
});
