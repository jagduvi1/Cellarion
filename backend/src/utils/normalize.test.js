const {
  normalizeString,
  tokenize,
  generateWineKey,
  levenshteinDistance,
  calculateSimilarity,
  generateTrigrams,
  trigramSimilarity,
  tokenSimilarity,
  combinedSimilarity,
  resolveCountryName,
  isUnknownName,
  isJunkGrapeName,
  resolveGrapeName,
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

// ─── resolveCountryName ──────────────────────────────────────────────────────

describe('resolveCountryName', () => {
  test('returns falsy input unchanged', () => {
    expect(resolveCountryName(null)).toBe(null);
    expect(resolveCountryName('')).toBe('');
    expect(resolveCountryName('   ')).toBe('   ');
  });

  test('maps English abbreviations to canonical names', () => {
    expect(resolveCountryName('USA')).toBe('United States');
    expect(resolveCountryName('U.S.A.')).toBe('United States'); // punctuation stripped
    expect(resolveCountryName('US')).toBe('United States');
    expect(resolveCountryName('United States of America')).toBe('United States');
    expect(resolveCountryName('America')).toBe('United States');
  });

  test('maps local-language names to canonical English (the prod duplicates)', () => {
    // Each of these existed as a duplicate Country document on prod
    expect(resolveCountryName('Tyskland')).toBe('Germany');   // Swedish
    expect(resolveCountryName('Italie')).toBe('Italy');       // French
    expect(resolveCountryName('New Zeeland')).toBe('New Zealand'); // typo
  });

  test('maps United Kingdom to England (canonical wine country)', () => {
    expect(resolveCountryName('United Kingdom')).toBe('England');
    expect(resolveCountryName('UK')).toBe('England');
    expect(resolveCountryName('Great Britain')).toBe('England');
  });

  test('handles diacritics and hyphens through normalizeString', () => {
    expect(resolveCountryName('Österrike')).toBe('Austria');        // Swedish, Ö → o
    expect(resolveCountryName('Nouvelle-Zélande')).toBe('New Zealand'); // hyphen deleted
    expect(resolveCountryName('États-Unis')).toBe('United States');
    expect(resolveCountryName('Großbritannien')).toBe('England');   // ß stripped
    expect(resolveCountryName('Südafrika')).toBe('South Africa');
  });

  test('is case-insensitive', () => {
    expect(resolveCountryName('tyskland')).toBe('Germany');
    expect(resolveCountryName('FRANKRIKE')).toBe('France');
  });

  test('returns canonical names unchanged', () => {
    expect(resolveCountryName('France')).toBe('France');
    expect(resolveCountryName('United States')).toBe('United States');
    expect(resolveCountryName('England')).toBe('England');
    expect(resolveCountryName('South Africa')).toBe('South Africa');
  });

  test('passes unknown countries through trimmed', () => {
    expect(resolveCountryName('  Uzbekistan  ')).toBe('Uzbekistan');
    expect(resolveCountryName('Atlantis')).toBe('Atlantis');
  });
});

// ─── isUnknownName / isJunkGrapeName ─────────────────────────────────────────

describe('isUnknownName', () => {
  test('true for empty/falsy input', () => {
    expect(isUnknownName(null)).toBe(true);
    expect(isUnknownName('')).toBe(true);
    expect(isUnknownName('   ')).toBe(true);
  });

  test('true for placeholder values in several languages (the prod junk)', () => {
    // Each of these existed as a taxonomy document on prod
    expect(isUnknownName('Unknown')).toBe(true);
    expect(isUnknownName('unknown')).toBe(true);
    expect(isUnknownName('Okänd')).toBe(true);     // sv
    expect(isUnknownName('Unbekannt')).toBe(true); // de
    expect(isUnknownName('Inconnu')).toBe(true);   // fr
    expect(isUnknownName('N/A')).toBe(true);
    expect(isUnknownName('n.a.')).toBe(true);
    expect(isUnknownName('none')).toBe(true);
    expect(isUnknownName('Not specified')).toBe(true);
    expect(isUnknownName('?')).toBe(true);   // normalizes to empty
    expect(isUnknownName('-')).toBe(true);   // normalizes to empty
  });

  test('false for real names', () => {
    expect(isUnknownName('Mendoza')).toBe(false);
    expect(isUnknownName('Napa Valley')).toBe(false);
    expect(isUnknownName('Germany')).toBe(false);
    // 'Nahe' must not be confused with placeholder 'na'
    expect(isUnknownName('Nahe')).toBe(false);
  });
});

describe('isJunkGrapeName', () => {
  test('rejects placeholders and hedge descriptions (real prod examples)', () => {
    expect(isJunkGrapeName('unknown')).toBe(true);
    expect(isJunkGrapeName('Red Blend')).toBe(true);
    expect(isJunkGrapeName('blend - specific varieties unknown')).toBe(true);
    expect(isJunkGrapeName('unknown white blend')).toBe(true);
    expect(isJunkGrapeName('blend of 40 botanicals including orange peel')).toBe(true);
    expect(isJunkGrapeName('unknown - likely Riesling, Gewurztraminer, Pinot Gris, or Muscat')).toBe(true);
  });

  test('accepts real varietals, including compound names', () => {
    expect(isJunkGrapeName('Syrah')).toBe(false);
    expect(isJunkGrapeName('Cabernet Sauvignon')).toBe(false);
    expect(isJunkGrapeName('Refosco dal Peduncolo Rosso')).toBe(false);
    expect(isJunkGrapeName('Moscato Bianco')).toBe(false);
    expect(isJunkGrapeName('Colombard')).toBe(false);
  });
});

describe('resolveGrapeName — Sangiovese Grosso', () => {
  test('maps the Montalcino local name to Sangiovese', () => {
    expect(resolveGrapeName('Sangiovese Grosso')).toBe('Sangiovese');
  });
});

describe('resolveGrapeName — spelling variants merged 2026-07-11', () => {
  test('maps spelling variants and typos to canonical names', () => {
    expect(resolveGrapeName('Agiorghitiko')).toBe('Agiorgitiko');
    expect(resolveGrapeName('Inzolia')).toBe('Insolia');
    expect(resolveGrapeName('Corvina Veronese')).toBe('Corvina');
    expect(resolveGrapeName('Sylvaner')).toBe('Silvaner');
    expect(resolveGrapeName('Tinta Barocca')).toBe('Tinta Barroca');
    expect(resolveGrapeName('Tinta-Roriz')).toBe('Tinta Roriz'); // hyphen deleted by normalizeString
    expect(resolveGrapeName('Verdehlo')).toBe('Verdelho');
    expect(resolveGrapeName('Vidal')).toBe('Vidal Blanc');
    expect(resolveGrapeName('Portugieser')).toBe('Blauer Portugieser');
  });

  test('ß-spelled Weißburgunder finally resolves to Pinot Blanc', () => {
    // normalizeString strips ß entirely ('weiburgunder'), so the old
    // 'weissburgunder' key never matched the real label spelling
    expect(resolveGrapeName('Weißburgunder')).toBe('Pinot Blanc');
    expect(resolveGrapeName('Weisser Burgunder')).toBe('Pinot Blanc');
  });
});
