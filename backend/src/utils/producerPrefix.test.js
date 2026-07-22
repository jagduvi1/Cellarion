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

// ── Key-token twin: producer VARIANTS (registry duplicate analysis 2026-07-22) ─
describe('stripProducerKeyPrefix', () => {
  const { stripProducerKeyPrefix } = require('./producerPrefix');

  test('strips the key run when the producer string is a variant — the July prod duplicates', () => {
    expect(stripProducerKeyPrefix('Felton Road Block 3 Pinot Noir', 'Felton Road Wines Ltd'))
      .toBe('Block 3 Pinot Noir');
    expect(stripProducerKeyPrefix('Maude Kids Block Pinot Noir', 'Maude Wines'))
      .toBe('Kids Block Pinot Noir');
    expect(stripProducerKeyPrefix('St Hugo Cabernet Sauvignon', 'St Hugo Wines'))
      .toBe('Cabernet Sauvignon');
    expect(stripProducerKeyPrefix('Cloudy Bay Sauvignon Blanc', 'Cloudy Bay Vineyards'))
      .toBe('Sauvignon Blanc');
  });

  test('skips leading house/stop words that the comparison key drops', () => {
    // key("La Vialla") = "vialla"; "Fattoria" and "La" belong to the producer reference
    expect(stripProducerKeyPrefix('Fattoria La Vialla Chianti', 'La Vialla')).toBe('Chianti');
    // key("La Rioja Alta, S.A.") = "rioja alta"
    expect(stripProducerKeyPrefix('La Rioja Alta Gran Reserva 904', 'La Rioja Alta, S.A.'))
      .toBe('Gran Reserva 904');
  });

  test('preserves original casing and punctuation of the remainder', () => {
    expect(stripProducerKeyPrefix("Miner Family The Iliad", 'Miner Family Winery'))
      .toBe('The Iliad');
  });

  test('never strips a SUFFIX — legitimate names end with the producer key', () => {
    // "Les Forts de Latour" IS the second wine's name; key("Château Latour") = "latour"
    expect(stripProducerKeyPrefix('Les Forts de Latour', 'Château Latour')).toBeNull();
  });

  test('requires the FULL key run — partial producer overlap never strips', () => {
    expect(stripProducerKeyPrefix('Felton Something Pinot Noir', 'Felton Road Wines Ltd')).toBeNull();
    expect(stripProducerKeyPrefix('Block 3 Pinot Noir', 'Felton Road Wines Ltd')).toBeNull();
  });

  test('never strips to nothing', () => {
    expect(stripProducerKeyPrefix('Felton Road', 'Felton Road Wines Ltd')).toBeNull();
    expect(stripProducerKeyPrefix('Fattoria La Vialla', 'La Vialla')).toBeNull();
  });

  test('word-boundary safe — a producer key inside a longer word never strips', () => {
    // normalize("Felton-Road") = "feltonroad" ≠ token "felton"
    expect(stripProducerKeyPrefix('Felton-Road Block 3', 'Felton Road Wines Ltd')).toBeNull();
  });

  test('returns null for empty inputs or an all-stopword producer', () => {
    expect(stripProducerKeyPrefix('', 'Felton Road Wines Ltd')).toBeNull();
    expect(stripProducerKeyPrefix('Chardonnay Reserve', 'Domaine')).toBeNull();
    expect(stripProducerKeyPrefix(null, 'Felton Road')).toBeNull();
    expect(stripProducerKeyPrefix('Felton Road Riesling', undefined)).toBeNull();
  });
});
