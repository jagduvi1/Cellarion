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
