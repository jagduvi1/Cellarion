const {
  normalizeString,
  tokenize,
  generateWineKey,
  levenshteinDistance,
  calculateSimilarity,
  isSimilar,
  generateTrigrams,
  trigramSimilarity,
  tokenSimilarity,
  combinedSimilarity,
} = require('./normalize');

// ─── normalizeString ──────────────────────────────────────────────────────────

describe('normalizeString', () => {
  test('returns empty string for falsy input', () => {
    expect(normalizeString(null)).toBe('');
    expect(normalizeString(undefined)).toBe('');
    expect(normalizeString('')).toBe('');
  });

  test('lowercases input', () => {
    expect(normalizeString('Château Margaux')).toContain('margaux');
  });

  test('removes accents/diacritics', () => {
    expect(normalizeString('château')).toBe('chateau');
    expect(normalizeString('Côtes du Rhône')).toBe('cotes du rhone');
  });

  test('removes punctuation (hyphens deleted, not replaced with spaces)', () => {
    // The regex strips non-word chars without inserting a space, so
    // hyphenated words run together: "Pétrus-Pomerol" → "petruspomerol"
    expect(normalizeString("Pétrus-Pomerol, 2018!")).toBe('petruspomerol 2018');
  });

  test('collapses multiple spaces', () => {
    expect(normalizeString('hello   world')).toBe('hello world');
  });

  test('trims leading and trailing whitespace', () => {
    expect(normalizeString('  trimmed  ')).toBe('trimmed');
  });
});

// ─── tokenize ────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  test('returns empty array for falsy input', () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });

  test('splits on whitespace', () => {
    expect(tokenize('pinot noir')).toEqual(['pinot', 'noir']);
  });

  test('removes stop words', () => {
    // 'chateau', 'domaine', 'le', 'de', 'the', 'reserve' are stop words
    const tokens = tokenize('Château Margaux de la Reserve');
    expect(tokens).not.toContain('chateau');
    expect(tokens).not.toContain('de');
    expect(tokens).not.toContain('la');
    expect(tokens).not.toContain('reserve');
    expect(tokens).toContain('margaux');
  });

  test('removes accents before comparing to stop words', () => {
    // 'château' normalizes to 'chateau' which is in the stop word list
    const tokens = tokenize('château margaux');
    expect(tokens).not.toContain('chateau');
    expect(tokens).toContain('margaux');
  });
});

// ─── generateWineKey ─────────────────────────────────────────────────────────

describe('generateWineKey', () => {
  test('produces a consistent colon-delimited key', () => {
    const key = generateWineKey('Grand Cru', 'Domaine Leflaive', 'Puligny');
    expect(key).toBe('domaine leflaive:grand cru:puligny');
  });

  test('defaults appellation to empty string', () => {
    const key = generateWineKey('Merlot', 'Opus One');
    expect(key).toBe('opus one:merlot:');
  });

  test('normalizes all three components', () => {
    const key = generateWineKey('Château Pétrus', 'Pétrus', 'Pomerol');
    expect(key).toBe('petrus:chateau petrus:pomerol');
  });
});

// ─── levenshteinDistance ──────────────────────────────────────────────────────

describe('levenshteinDistance', () => {
  test('identical strings → 0', () => {
    expect(levenshteinDistance('wine', 'wine')).toBe(0);
  });

  test('empty string to non-empty → length of non-empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  test('single substitution', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  test('single insertion', () => {
    expect(levenshteinDistance('wine', 'wines')).toBe(1);
  });

  test('single deletion', () => {
    expect(levenshteinDistance('wines', 'wine')).toBe(1);
  });

  test('known pair: kitten → sitting = 3', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });
});

// ─── calculateSimilarity ─────────────────────────────────────────────────────

describe('calculateSimilarity', () => {
  test('identical strings → 1', () => {
    expect(calculateSimilarity('bordeaux', 'bordeaux')).toBe(1);
  });

  test('identical after normalization → 1', () => {
    expect(calculateSimilarity('Château', 'chateau')).toBe(1);
  });

  test('returns 0 for falsy inputs', () => {
    expect(calculateSimilarity(null, 'wine')).toBe(0);
    expect(calculateSimilarity('wine', null)).toBe(0);
  });

  test('score is between 0 and 1', () => {
    const score = calculateSimilarity('pinot noir', 'pinot grigio');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('completely different strings → low score', () => {
    expect(calculateSimilarity('xyz', 'abc')).toBeLessThan(0.5);
  });

  test('close strings → high score', () => {
    expect(calculateSimilarity('chardonnay', 'chardonay')).toBeGreaterThan(0.8);
  });
});

// ─── isSimilar ───────────────────────────────────────────────────────────────

describe('isSimilar', () => {
  test('identical strings pass default threshold', () => {
    expect(isSimilar('merlot', 'merlot')).toBe(true);
  });

  test('very different strings fail default threshold', () => {
    expect(isSimilar('merlot', 'riesling')).toBe(false);
  });

  test('respects custom threshold', () => {
    // calculateSimilarity for one-char-off should pass 0.5 but may fail 0.99
    expect(isSimilar('wine', 'wines', 0.5)).toBe(true);
    expect(isSimilar('wine', 'wines', 0.99)).toBe(false);
  });
});

// ─── generateTrigrams ────────────────────────────────────────────────────────

describe('generateTrigrams', () => {
  test('returns empty Set for falsy input', () => {
    expect(generateTrigrams(null).size).toBe(0);
    expect(generateTrigrams('').size).toBe(0);
  });

  test('returns a Set of 3-character strings', () => {
    const trigrams = generateTrigrams('wine');
    for (const t of trigrams) {
      expect(t).toHaveLength(3);
    }
  });

  test('includes boundary padding trigrams', () => {
    // "wine" pads to "  wine " → first trigram is "  w"
    const trigrams = generateTrigrams('wine');
    expect(trigrams.has('  w')).toBe(true);
  });

  test('identical inputs produce the same Set', () => {
    const a = generateTrigrams('bordeaux');
    const b = generateTrigrams('bordeaux');
    expect(a.size).toBe(b.size);
    for (const t of a) expect(b.has(t)).toBe(true);
  });
});

// ─── trigramSimilarity ────────────────────────────────────────────────────────

describe('trigramSimilarity', () => {
  test('identical strings → 1', () => {
    expect(trigramSimilarity('chardonnay', 'chardonnay')).toBe(1);
  });

  test('returns 0 for falsy inputs', () => {
    expect(trigramSimilarity(null, 'wine')).toBe(0);
    expect(trigramSimilarity('wine', null)).toBe(0);
  });

  test('similar strings → high score', () => {
    expect(trigramSimilarity('chardonnay', 'chardonay')).toBeGreaterThan(0.6);
  });

  test('unrelated strings → low score', () => {
    expect(trigramSimilarity('merlot', 'riesling')).toBeLessThan(0.5);
  });

  test('score is between 0 and 1', () => {
    const score = trigramSimilarity('pinot noir', 'pinot grigio');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ─── tokenSimilarity ─────────────────────────────────────────────────────────

describe('tokenSimilarity', () => {
  test('identical strings → 1', () => {
    expect(tokenSimilarity('pinot noir', 'pinot noir')).toBe(1);
  });

  test('returns 0 for falsy inputs', () => {
    expect(tokenSimilarity(null, 'wine')).toBe(0);
    expect(tokenSimilarity('wine', null)).toBe(0);
  });

  test('completely overlapping tokens → 1', () => {
    // Stop words removed, same meaningful tokens
    expect(tokenSimilarity('grand cru margaux', 'margaux grand cru')).toBe(1);
  });

  test('no shared tokens → 0', () => {
    // After stop word removal, no overlap
    expect(tokenSimilarity('merlot cabernet', 'riesling gewurztraminer')).toBe(0);
  });

  test('partial overlap → score between 0 and 1', () => {
    const score = tokenSimilarity('pinot noir burgundy', 'pinot gris alsace');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ─── combinedSimilarity ───────────────────────────────────────────────────────

describe('combinedSimilarity', () => {
  test('identical strings → 1', () => {
    expect(combinedSimilarity('bordeaux', 'bordeaux')).toBe(1);
  });

  test('returns 0 for falsy inputs', () => {
    expect(combinedSimilarity(null, 'wine')).toBe(0);
    expect(combinedSimilarity('wine', null)).toBe(0);
  });

  test('score is between 0 and 1', () => {
    const score = combinedSimilarity('pinot noir', 'pinot grigio');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('clear duplicates score above the 0.75 dedup threshold', () => {
    // Minor typo variant should exceed the dedup threshold used in production
    const score = combinedSimilarity('Château Margaux', 'Chateau Margaux');
    expect(score).toBeGreaterThan(0.75);
  });

  test('clearly different wines score below the dedup threshold', () => {
    const score = combinedSimilarity('Opus One Cabernet', 'Cloudy Bay Sauvignon Blanc');
    expect(score).toBeLessThan(0.75);
  });

  test('reflects weighted combination of lev/trigram/token', () => {
    // Combined must be between the min and max of the individual scores
    const lev = calculateSimilarity('burgundy', 'burgundie');
    const tri = trigramSimilarity('burgundy', 'burgundie');
    const tok = tokenSimilarity('burgundy', 'burgundie');
    const combined = combinedSimilarity('burgundy', 'burgundie');
    expect(combined).toBeGreaterThanOrEqual(Math.min(lev, tri, tok));
    expect(combined).toBeLessThanOrEqual(Math.max(lev, tri, tok));
  });
});
