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

  test('Saint-spelling producer variants share one canonical identity — the Caronne split (ticket d49fea22)', () => {
    const canonical = computeCanonicalKey('Grand Vin', 'Château Caronne Sainte Gemme', 'Haut-Médoc');
    expect(computeCanonicalKey('Grand Vin', 'Château Caronne Ste Gemme', 'Haut-Médoc')).toBe(canonical);
    expect(computeCanonicalKey('Grand Vin', 'Chateau Caronne Saint Gemme', 'Haut-Médoc')).toBe(canonical);
    // The HYPHENATED spelling does NOT fold: normalizeString deletes hyphens,
    // gluing 'saintegemme' into one token the Saint fold never sees. Pinned as
    // a known limit — a producer-key hyphen fold would regress
    // stripProducerKeyPrefix on hyphenated producers, so that axis stays with
    // the human merge queue.
    expect(computeCanonicalKey('Grand Vin', 'Château Caronne Sainte-Gemme', 'Haut-Médoc')).not.toBe(canonical);
  });

  test('an only-a-founding-year producer falls back to the raw string, never one shared empty bucket', () => {
    expect(computeCanonicalKey('Red', '1846', '')).toBe('1846:red:');
    expect(computeCanonicalKey('Red', '1846', '')).not.toBe(computeCanonicalKey('Red', '1921', ''));
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
