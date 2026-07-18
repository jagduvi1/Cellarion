const { stripProducerPrefix } = require('./producerPrefix');

describe('stripProducerPrefix', () => {
  test('strips a plain producer prefix separated by a space', () => {
    expect(stripProducerPrefix('Meerlust Chardonnay', 'Meerlust')).toBe('Chardonnay');
  });

  test('is case-insensitive on the prefix match', () => {
    expect(stripProducerPrefix('MEERLUST Chardonnay', 'Meerlust')).toBe('Chardonnay');
    expect(stripProducerPrefix('meerlust Rubicon', 'Meerlust')).toBe('Rubicon');
  });

  test('strips hyphen and dash separators (with surrounding whitespace)', () => {
    expect(stripProducerPrefix('Meerlust - Chardonnay', 'Meerlust')).toBe('Chardonnay');
    expect(stripProducerPrefix('Meerlust – Rubicon', 'Meerlust')).toBe('Rubicon');
    expect(stripProducerPrefix('Meerlust—Rubicon', 'Meerlust')).toBe('Rubicon');
  });

  test('handles multi-word producers', () => {
    expect(stripProducerPrefix('Château Margaux Pavillon Rouge', 'Château Margaux'))
      .toBe('Pavillon Rouge');
  });

  test('returns null when the name does not start with the producer', () => {
    expect(stripProducerPrefix('Rubicon', 'Meerlust')).toBeNull();
    expect(stripProducerPrefix('Grand Meerlust Rubicon', 'Meerlust')).toBeNull();
  });

  test('returns null when the producer is only a substring of a longer word', () => {
    // "Chateau" is a prefix of "Chateauneuf" but not a redundant producer prefix
    expect(stripProducerPrefix('Chateauneuf-du-Pape', 'Chateau')).toBeNull();
  });

  test('returns null when the name equals the producer', () => {
    expect(stripProducerPrefix('Meerlust', 'Meerlust')).toBeNull();
  });

  test('returns null when nothing meaningful remains after stripping', () => {
    expect(stripProducerPrefix('Meerlust -', 'Meerlust')).toBeNull();
  });

  test('returns null for empty or non-string inputs', () => {
    expect(stripProducerPrefix('', 'Meerlust')).toBeNull();
    expect(stripProducerPrefix('Meerlust Chardonnay', '')).toBeNull();
    expect(stripProducerPrefix(null, 'Meerlust')).toBeNull();
    expect(stripProducerPrefix('Meerlust Chardonnay', undefined)).toBeNull();
  });
});

// ── Suffix twin + the shared entry point (launch-day admin report) ──────────
describe('stripProducerSuffix', () => {
  const { stripProducerSuffix, stripProducerName } = require('./producerPrefix');

  test('strips a trailing producer — the five real Mastroberardino rows', () => {
    const P = 'Mastroberardino';
    expect(stripProducerSuffix('Stilema Taurasi Mastroberardino', P)).toBe('Stilema Taurasi');
    expect(stripProducerSuffix('Lacrimarosa Mastroberardino', P)).toBe('Lacrimarosa');
    expect(stripProducerSuffix('Fiano di Avellino Mastroberardino', P)).toBe('Fiano di Avellino');
    expect(stripProducerSuffix('Radici Taurasi Riserva Antonio Mastroberardino', P)).toBe('Radici Taurasi Riserva Antonio');
    expect(stripProducerSuffix('Radici Fiano di Avellino Mastroberardino', P)).toBe('Radici Fiano di Avellino');
  });

  test('requires a separator before the suffix — a substring tail never counts', () => {
    expect(stripProducerSuffix('NeroRossi', 'Rossi')).toBeNull();
    expect(stripProducerSuffix('Barbera - Rossi', 'Rossi')).toBe('Barbera');
  });

  test('never strips to nothing, never fires on a prefix-only case', () => {
    expect(stripProducerSuffix('Mastroberardino', 'Mastroberardino')).toBeNull();
    expect(stripProducerSuffix(' Mastroberardino', 'Mastroberardino')).toBeNull();
    expect(stripProducerSuffix('Meerlust Chardonnay', 'Meerlust')).toBeNull();
  });

  test('stripProducerName handles either end, prefix first, and loops clean both-ends input', () => {
    expect(stripProducerName('Meerlust Chardonnay', 'Meerlust')).toBe('Chardonnay');
    expect(stripProducerName('Fiano di Avellino Mastroberardino', 'Mastroberardino')).toBe('Fiano di Avellino');
    // Both ends: one call strips the prefix; the create-time loop applies it
    // again for the suffix.
    const once = stripProducerName('Guigal Côte-Rôtie Guigal', 'Guigal');
    expect(once).toBe('Côte-Rôtie Guigal');
    expect(stripProducerName(once, 'Guigal')).toBe('Côte-Rôtie');
    expect(stripProducerName('Chardonnay', 'Meerlust')).toBeNull();
  });
});
