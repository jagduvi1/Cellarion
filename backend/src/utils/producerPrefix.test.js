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
