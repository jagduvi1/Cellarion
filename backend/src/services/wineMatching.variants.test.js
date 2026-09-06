/**
 * Producer-embedded name variants (scoreWineMatchVariants).
 *
 * WHY THIS TEST EXISTS:
 * The registry stores producer and wine name SEPARATELY, but import rows
 * often embed the producer inside the wine name — CellarTracker's Bottles/
 * Consumed tables have no Producer column, so the Wine value is the full
 * display name ("Domaine de la Romanée-Conti La Tâche") and the client-side
 * parser can only guess the producer. The registry-first import cascade
 * (audit M-2) relies on these rows still reaching the exact threshold
 * (>= 0.95) against their own registry wine — otherwise known wines are
 * missed and AI is called unnecessarily.
 *
 * The variant scorer must also be MONOTONIC (never lower than the raw
 * scorer) and must NOT cross-match sibling wines from the same producer.
 */

const {
  scoreWineMatch,
  scoreWineMatchVariants,
  concatNormalized,
  stripProducerPrefix,
} = require('./wineMatching');

const EXACT = 0.95;

// Registry wine — producer and name stored separately, per registry convention
const LA_TACHE = { name: 'La Tâche', producer: 'Domaine de la Romanée-Conti', appellation: '' };
// Sibling grand cru from the SAME producer — must never cross-match
const ROMANEE_CONTI = { name: 'Romanée-Conti', producer: 'Domaine de la Romanée-Conti', appellation: '' };

describe('scoreWineMatchVariants — producer-embedded import rows', () => {
  test('(i) empty producer + full display name reaches exact threshold', () => {
    const row = { name: 'Domaine de la Romanée-Conti La Tâche', producer: '', appellation: '' };
    expect(scoreWineMatchVariants(LA_TACHE, row)).toBeGreaterThanOrEqual(EXACT);
  });

  test('(ii) producer set AND embedded in the name reaches exact threshold', () => {
    const row = {
      name: 'Domaine de la Romanée-Conti La Tâche',
      producer: 'Domaine de la Romanée-Conti',
      appellation: '',
    };
    expect(scoreWineMatchVariants(LA_TACHE, row)).toBeGreaterThanOrEqual(EXACT);
  });

  test('(iii) diacritic-free row matches the accented registry wine exactly', () => {
    const row = { name: 'La Tache', producer: 'Domaine de la Romanee-Conti', appellation: '' };
    expect(scoreWineMatchVariants(LA_TACHE, row)).toBeGreaterThanOrEqual(EXACT);
  });

  test('negative: sibling wines from the same producer do NOT cross-match', () => {
    // Full display name of La Tâche scored against the Romanée-Conti sibling —
    // the concatenated signal must not treat them as the same wine.
    const row = { name: 'Domaine de la Romanée-Conti La Tâche', producer: '', appellation: '' };
    expect(scoreWineMatchVariants(ROMANEE_CONTI, row)).toBeLessThan(EXACT);

    // And with the producer split out correctly, still no sibling cross-match.
    const cleanRow = { name: 'La Tâche', producer: 'Domaine de la Romanée-Conti', appellation: '' };
    expect(scoreWineMatchVariants(ROMANEE_CONTI, cleanRow)).toBeLessThan(EXACT);
  });

  test('monotonic: variant score is never below the raw scoreWineMatch', () => {
    const rows = [
      { name: 'La Tâche', producer: 'Domaine de la Romanée-Conti', appellation: '' },
      { name: 'Domaine de la Romanée-Conti La Tâche', producer: '', appellation: '' },
      { name: 'Barolo Riserva', producer: 'Giacomo Conterno', appellation: 'Barolo DOCG' },
      { name: 'Completely Unrelated', producer: 'Someone Else', appellation: '' },
    ];
    for (const row of rows) {
      for (const candidate of [LA_TACHE, ROMANEE_CONTI]) {
        expect(scoreWineMatchVariants(candidate, row))
          .toBeGreaterThanOrEqual(scoreWineMatch(candidate, row));
      }
    }
  });

  test('unrelated wines still score low', () => {
    const row = { name: 'Sauvignon Blanc', producer: 'Cloudy Bay', appellation: '' };
    expect(scoreWineMatchVariants(LA_TACHE, row)).toBeLessThan(0.5);
  });
});

// The concat-equality shortcut ignores appellation, so two registry siblings
// with the SAME producer+name but DIFFERENT appellations must not both be
// forced to an exact 1 (arbitrary matches[0] auto-accepted). The appellation
// has to actually disambiguate.
describe('appellation disambiguation — same producer+name siblings (BUG 3)', () => {
  const P = 'Giacomo Conterno';
  const N = 'Barolo';
  const C1 = { producer: P, name: N, appellation: 'Cascina Francia' };
  const C2 = { producer: P, name: N, appellation: 'Monfortino' };

  test('no query appellation → neither sibling is forced to an exact 1', () => {
    const query = { producer: P, name: N, appellation: '' };
    expect(scoreWineMatchVariants(C1, query)).toBeLessThan(1);
    expect(scoreWineMatchVariants(C2, query)).toBeLessThan(1);
  });

  test('a query appellation matches only its own sibling exactly; the other drops below the exact threshold', () => {
    const query = { producer: P, name: N, appellation: 'Cascina Francia' };
    expect(scoreWineMatchVariants(C1, query)).toBeGreaterThanOrEqual(1); // exact — appellations agree
    expect(scoreWineMatchVariants(C2, query)).toBeLessThan(EXACT);       // forced disambiguation
  });

  test('monotonic: variant score is still never below the raw scorer for these siblings', () => {
    const query = { producer: P, name: N, appellation: 'Cascina Francia' };
    for (const c of [C1, C2]) {
      expect(scoreWineMatchVariants(c, query)).toBeGreaterThanOrEqual(scoreWineMatch(c, query));
    }
  });
});

describe('helpers', () => {
  test('concatNormalized dedups an embedded producer prefix', () => {
    // normalizeString drops punctuation without padding: 'Romanée-Conti' → 'romaneeconti'
    expect(concatNormalized('Domaine de la Romanée-Conti', 'Domaine de la Romanée-Conti La Tâche'))
      .toBe('domaine de la romaneeconti la tache');
    expect(concatNormalized('Domaine de la Romanée-Conti', 'La Tâche'))
      .toBe('domaine de la romaneeconti la tache');
    expect(concatNormalized('', 'Domaine de la Romanée-Conti La Tâche'))
      .toBe('domaine de la romaneeconti la tache');
  });

  test('stripProducerPrefix returns the normalized remainder or null', () => {
    expect(stripProducerPrefix('Domaine de la Romanée-Conti La Tâche', 'Domaine de la Romanee-Conti'))
      .toBe('la tache');
    expect(stripProducerPrefix('La Tâche', 'Domaine de la Romanée-Conti')).toBeNull();
    // Name identical to the producer — nothing left to strip
    expect(stripProducerPrefix('Cloudy Bay', 'Cloudy Bay')).toBeNull();
    expect(stripProducerPrefix('Anything', '')).toBeNull();
  });
});

// ── Appellation-first names + bracketed producers (registry backlog 2026-09-06) ──
//
// Real rows from a CellarTracker re-import: 44 requests, every one for a wine
// that already existed. CT composes "Wine" as producer + appellation +
// designation, so after producer-stripping the name still leads with the
// appellation; producers carry a parenthetical the registry does not.
const {
  stripAppellationPrefix,
  stripProducerBrackets,
  importQueryVariants,
} = require('./wineMatching');

describe('appellation-first import rows reach the exact threshold against their registry wine', () => {
  const cases = [
    ['Muga Prado Enea', { name: 'Rioja Prado Enea Gran Reserva', producer: 'Bodegas Muga', appellation: 'Rioja' },
      { name: 'Prado Enea Gran Reserva', producer: 'Muga', appellation: 'Rioja' }],
    ['Magari (bracketed producer)', { name: 'Magari', producer: "Ca' Marcanda (Gaja)", appellation: 'Bolgheri' },
      { name: 'Magari', producer: "Ca' Marcanda", appellation: 'Bolgheri' }],
    ['Cavallotto Bricco Boschis', { name: 'Barolo Bricco Boschis', producer: 'Cavallotto', appellation: 'Barolo' },
      { name: 'Bricco Boschis', producer: 'Cavallotto', appellation: 'Barolo' }],
    ['Château Lagrange (St. Julien)', { name: 'Château Lagrange (St. Julien)', producer: 'Château Lagrange (St. Julien)', appellation: 'Saint-Julien' },
      { name: 'Château Lagrange', producer: 'Château Lagrange', appellation: 'Saint-Julien' }],
    ['Xisto Cru Branco (region hint only)', { name: 'Douro Xisto Cru Branco', producer: 'Luís Seabra Vinhos', appellation: 'Douro', region: 'Douro' },
      { name: 'Xisto Cru Branco', producer: 'Luis Seabra Vinhos', appellation: 'Douro' }],
    ['Fonterutoli (DOCG suffix on the hint)', { name: 'Chianti Classico Castello di Fonterutoli Gran Selezione', producer: 'Marchesi Mazzei', appellation: 'Chianti Classico DOCG' },
      { name: 'Castello di Fonterutoli Gran Selezione', producer: 'Marchesi Mazzei', appellation: 'Chianti Classico' }],
  ];
  test.each(cases)('%s', (_label, row, registry) => {
    expect(scoreWineMatchVariants(registry, row)).toBeGreaterThanOrEqual(EXACT);
    // Monotonic: never below the raw scorer.
    expect(scoreWineMatchVariants(registry, row)).toBeGreaterThanOrEqual(scoreWineMatch(registry, row));
  });

  test('the registry side may carry the bracket instead', () => {
    const registry = { name: 'Chapelle des Bois', producer: "Jean-Louis Dutraive (Domaine de la Grand'Cour)", appellation: 'Fleurie' };
    const row = { name: 'Fleurie Chapelle des Bois', producer: 'Jean-Louis Dutraive', appellation: 'Fleurie' };
    expect(scoreWineMatchVariants(registry, row)).toBeGreaterThanOrEqual(EXACT);
  });

  test('negative: a different wine of the same producer and appellation does not cross-match', () => {
    const registry = { name: 'Prado Enea Gran Reserva', producer: 'Muga', appellation: 'Rioja' };
    expect(scoreWineMatchVariants(registry, { name: 'Rioja Reserva', producer: 'Bodegas Muga', appellation: 'Rioja' })).toBeLessThan(0.85);
    expect(scoreWineMatchVariants(registry, { name: 'Rioja Torre Muga', producer: 'Bodegas Muga', appellation: 'Rioja' })).toBeLessThan(0.85);
  });

  test('negative: same appellation-first name, different producer, stays a soft candidate at most', () => {
    const registry = { name: '1er Cru Beauroy', producer: "Domaine de l'Enclos", appellation: 'Chablis Premier Cru' };
    expect(scoreWineMatchVariants(registry, { name: 'Chablis 1er Cru Beauroy', producer: 'Domaine Laroche', appellation: 'Chablis 1er Cru' })).toBeLessThan(EXACT);
  });
});

describe('the helpers', () => {
  test('stripAppellationPrefix strips the hint head, folds tier suffixes, and refuses bare styles', () => {
    expect(stripAppellationPrefix('Rioja Prado Enea Gran Reserva', 'Rioja')).toBe('prado enea gran reserva');
    expect(stripAppellationPrefix('Chianti Classico Castello di Fonterutoli', 'Chianti Classico DOCG')).toBe('castello di fonterutoli');
    expect(stripAppellationPrefix('Rioja Reserva', 'Rioja')).toBeNull();          // a style is not a name
    expect(stripAppellationPrefix('Rioja', 'Rioja')).toBeNull();                  // nothing left
    expect(stripAppellationPrefix('Riojana Cuvée', 'Rioja')).toBeNull();          // word boundary
    expect(stripAppellationPrefix('Prado Enea', '')).toBeNull();
  });
  test('stripProducerBrackets removes only a trailing parenthetical', () => {
    expect(stripProducerBrackets("Ca' Marcanda (Gaja)")).toBe("Ca' Marcanda");
    expect(stripProducerBrackets('Château Lagrange (St. Julien)')).toBe('Château Lagrange');
    expect(stripProducerBrackets('Muga')).toBeNull();
    expect(stripProducerBrackets('(Unknown)')).toBeNull();
  });
  test('importQueryVariants yields the raw query, then the cleaned one, without duplicates', () => {
    expect(importQueryVariants({ producer: 'Bodegas Muga', wineName: 'Rioja Prado Enea Gran Reserva', appellation: 'Rioja' }))
      .toEqual(['Bodegas Muga Rioja Prado Enea Gran Reserva', 'Bodegas Muga prado enea gran reserva']);
    expect(importQueryVariants({ producer: 'Muga', wineName: 'Prado Enea', appellation: 'Rioja' })).toEqual(['Muga Prado Enea']);
  });
});

describe('the vineyard-as-appellation guard', () => {
  test('a Mosel row whose CT "appellation" is the single vineyard keeps the vineyard in the name', () => {
    expect(stripAppellationPrefix('Wehlener Sonnenuhr Riesling Auslese', 'Wehlener Sonnenuhr')).toBeNull();
    expect(stripAppellationPrefix('Wehlener Sonnenuhr Riesling Auslese Goldkapsel', 'Wehlener Sonnenuhr')).toBe('riesling auslese goldkapsel');
    const registry = { name: 'Wehlener Sonnenuhr Riesling Auslese', producer: 'Joh. Jos. Prüm', appellation: 'Wehlener Sonnenuhr' };
    expect(scoreWineMatchVariants(registry, { name: 'Wehlener Sonnenuhr Riesling Auslese', producer: 'Joh. Jos. Prüm', appellation: 'Wehlener Sonnenuhr' })).toBeGreaterThanOrEqual(EXACT);
  });
});
