const { nameSignature, findDuplicateClusters } = require('./taxonomyDuplicates');

/**
 * Every case below is a REAL row from production on 2026-08-31, when the Loire
 * was found split across four region documents holding 208 wines between them.
 *
 * The rejections matter more than the matches. A scan that proposes merging
 * Haut-Médoc into Médoc, or Montagne-Saint-Émilion into Saint-Émilion, would
 * destroy distinctions the whole registry depends on — and the merge route
 * deletes the source document, so a wrong proposal an admin accepts is not
 * cheaply undone.
 */

describe('the Loire — the cluster this scan exists for', () => {
  test('all four spellings reduce to the same signature', () => {
    const sigs = ['Loire Valley', 'Vallée de la Loire', 'Val de Loire', 'Loire'].map(nameSignature);
    expect(new Set(sigs).size).toBe(1);
    expect(sigs[0]).toBe('loire');
  });

  test('they cluster together, and the cluster names them all', () => {
    const clusters = findDuplicateClusters([
      { _id: '1', name: 'Loire Valley', scope: 'FR' },
      { _id: '2', name: 'Vallée de la Loire', scope: 'FR' },
      { _id: '3', name: 'Val de Loire', scope: 'FR' },
      { _id: '4', name: 'Loire', scope: 'FR' },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m._id).sort()).toEqual(['1', '2', '3', '4']);
  });
});

describe('punctuation and case differences', () => {
  test('Languedoc-Roussillon and "Languedoc Roussillon" are one place', () => {
    expect(nameSignature('Languedoc-Roussillon')).toBe(nameSignature('Languedoc Roussillon'));
  });

  test('but Languedoc alone is NOT the same as Languedoc-Roussillon', () => {
    // Roussillon is a distinct region — Banyuls, Maury, Collioure. Merging
    // these would erase that, and prod carries 85 and 67 wines on them.
    expect(nameSignature('Languedoc')).not.toBe(nameSignature('Languedoc-Roussillon'));
    expect(nameSignature('Roussillon')).not.toBe(nameSignature('Languedoc-Roussillon'));
    expect(nameSignature('Languedoc')).not.toBe(nameSignature('Roussillon'));
  });
});

describe('qualifiers that must stay meaningful', () => {
  test.each([
    ['Médoc', 'Haut-Médoc', 'a different appellation, not a spelling of it'],
    ['Bergerac', 'Côtes de Bergerac', 'côtes names a distinct AOC'],
    ['Saint-Émilion', 'Montagne-Saint-Émilion', 'Montagne is its own commune'],
    ['Pomerol', 'Lalande-de-Pomerol', 'Lalande is its own appellation'],
    ['Minervois', 'Minervois La Livinière', 'La Livinière is a cru'],
    ['Adige', 'Alto Adige', 'alto is not decoration'],
    ['Savoie', 'Savoie - Haute Savoie', 'conservative: haute stays meaningful'],
  ])('%s is not %s (%s)', (a, b) => {
    expect(nameSignature(a)).not.toBe(nameSignature(b));
  });

  test('Jura and Jurançon differ — a substring is not a token', () => {
    // The plain overlap scan that found the Loire also proposed this pair,
    // because "jura" is a substring of "jurancon". It is not a token of it.
    expect(nameSignature('Jura')).not.toBe(nameSignature('Jurançon'));
  });
});

describe('scope', () => {
  test('the same name in two countries is never one cluster', () => {
    const clusters = findDuplicateClusters([
      { _id: 'us', name: 'Georgia', scope: 'US' },
      { _id: 'ge', name: 'Georgia', scope: 'GE' },
    ]);
    expect(clusters).toHaveLength(0);
  });

  test('a lone document is not a cluster', () => {
    expect(findDuplicateClusters([{ _id: '1', name: 'Barolo', scope: 'IT' }])).toHaveLength(0);
  });
});

describe('degenerate input', () => {
  test('a name of nothing but stop words compares on its full tokens', () => {
    // "Valle" must still equal "Valle" rather than emptying to '' and
    // clustering with every other emptied name.
    expect(nameSignature('Valle')).toBe('valle');
    expect(nameSignature('Valle')).not.toBe(nameSignature('Val'));
  });

  test('empty, punctuation-only and missing names yield no signature and no cluster', () => {
    expect(nameSignature('')).toBe('');
    expect(nameSignature('   ')).toBe('');
    expect(nameSignature(null)).toBe('');
    expect(nameSignature(undefined)).toBe('');
    expect(findDuplicateClusters([
      { _id: '1', name: '', scope: 'FR' },
      { _id: '2', name: '  ', scope: 'FR' },
    ])).toHaveLength(0);
  });

  test('duplicate tokens collapse, so word order never matters', () => {
    expect(nameSignature('Rhone Vallee du Rhone')).toBe(nameSignature('Rhone'));
    expect(nameSignature('Napa Valley')).toBe(nameSignature('Valley Napa'));
  });

  test('no documents at all is an empty result, not a throw', () => {
    expect(findDuplicateClusters([])).toEqual([]);
    expect(findDuplicateClusters(undefined)).toEqual([]);
  });
});

describe('ordering', () => {
  test('the largest cluster comes first — most wines to consolidate', () => {
    const clusters = findDuplicateClusters([
      { _id: 'a1', name: 'Rioja', scope: 'ES' },
      { _id: 'a2', name: 'La Rioja', scope: 'ES' },
      { _id: 'b1', name: 'Loire Valley', scope: 'FR' },
      { _id: 'b2', name: 'Val de Loire', scope: 'FR' },
      { _id: 'b3', name: 'Loire', scope: 'FR' },
    ]);
    expect(clusters[0].members).toHaveLength(3);
    expect(clusters[1].members).toHaveLength(2);
  });
});
