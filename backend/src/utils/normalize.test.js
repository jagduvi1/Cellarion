const {
  normalizeString,
  tokenize,
  normalizeProducerKey,
  generateWineKey,
  normalizeAppellation,
  levenshteinDistance,
  calculateSimilarity,
  generateTrigrams,
  trigramSimilarity,
  tokenSimilarity,
  combinedSimilarity,
  resolveCountryName,
  isRecognizedCountry,
  isUnknownName,
  isJunkGrapeName,
  resolveGrapeName,
  stripTrailingVintage,
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

describe('normalizeAppellation (ticket #2C: tier-suffix proliferation)', () => {
  test('strips the trailing classification tier', () => {
    expect(normalizeAppellation('Barolo DOCG')).toBe('Barolo');
    expect(normalizeAppellation('Barolo')).toBe('Barolo');
    expect(normalizeAppellation('Napa Valley AVA')).toBe('Napa Valley');
    expect(normalizeAppellation('Chianti Classico DOCG')).toBe('Chianti Classico');
    expect(normalizeAppellation('Rueda, DO')).toBe('Rueda, DO'); // 'do' deliberately NOT stripped
  });

  test('the two Barolo variants converge to one canonical form', () => {
    expect(normalizeAppellation('Barolo DOCG')).toBe(normalizeAppellation('Barolo'));
  });

  test('does not strip a tier token that is part of the place name', () => {
    // No trailing tier here — "Classico" is part of the name, left intact.
    expect(normalizeAppellation('Chianti Classico')).toBe('Chianti Classico');
  });

  test('passes null/undefined through and never returns empty', () => {
    expect(normalizeAppellation(null)).toBeNull();
    expect(normalizeAppellation(undefined)).toBeUndefined();
    expect(normalizeAppellation('DOCG')).toBe('DOCG'); // all-tier input preserved, not emptied
    expect(normalizeAppellation('   Barolo   DOCG ')).toBe('Barolo');
  });

  test('strips LEADING tier tokens — the prefix form the audit found surviving (RC-4)', () => {
    expect(normalizeAppellation('DO Alicante')).toBe('Alicante');
    expect(normalizeAppellation('DOCa Rioja')).toBe('Rioja');
    expect(normalizeAppellation('IGT Toscana')).toBe('Toscana');
    expect(normalizeAppellation('IGP Pays d\'Hérault')).toBe('Pays d\'Hérault');
    expect(normalizeAppellation('D.O. Valle Central')).toBe('Valle Central'); // dots tolerated
    expect(normalizeAppellation('DO')).toBe('DO'); // never emptied
  });

  test('audit additions to the trailing set: DOP / DOQ / VQA / WO', () => {
    expect(normalizeAppellation('Sicilia DOP')).toBe('Sicilia');
    expect(normalizeAppellation('Priorat DOQ')).toBe('Priorat');
    expect(normalizeAppellation('Ontario VQA')).toBe('Ontario');
    expect(normalizeAppellation('Swartland WO')).toBe('Swartland');
  });

  // Prod 2026-08-13: "Lison Classico D.O.C.G." kept its tier. The LEADING loop
  // has always folded dots out of the candidate token ("D.O. Valle Central"
  // above); the trailing loop only trimmed dots off the END, so 'd.o.c.g'
  // never matched anything in the tier set and the abbreviated forms labels
  // actually print sailed straight through into the registry.
  test('strips a DOTTED trailing tier, the same fold the leading loop uses', () => {
    expect(normalizeAppellation('Lison Classico D.O.C.G.')).toBe('Lison Classico');
    expect(normalizeAppellation('Rioja D.O.Ca.')).toBe('Rioja');
    expect(normalizeAppellation('Barolo D.O.C.G')).toBe('Barolo');       // no closing dot
    expect(normalizeAppellation('Napa Valley A.V.A.')).toBe('Napa Valley');
    // …and it converges with the undotted spelling, which is the whole point.
    expect(normalizeAppellation('Rioja D.O.Ca.')).toBe(normalizeAppellation('Rioja DOCa'));
  });

  test('a REAL name whose tokens carry dots is untouched — folding is not stripping', () => {
    // Nothing here folds INTO the tier set, so the loop must stop on the first
    // token and leave every dot in the returned string exactly where it was.
    expect(normalizeAppellation('Nuits-St.-Georges Premier Cru')).toBe('Nuits-St.-Georges Premier Cru');
    expect(normalizeAppellation('Nuits-St.-Georges')).toBe('Nuits-St.-Georges');
    expect(normalizeAppellation('St. Emilion Grand Cru')).toBe('St. Emilion Grand Cru');
    // 'do' is trailing-only-excluded on purpose (it collides with real place
    // words); the dotted spelling must inherit that exclusion, not escape it.
    expect(normalizeAppellation('Rueda D.O.')).toBe('Rueda D.O.');
  });

  test('the audit leave-alone list survives untouched', () => {
    // Official appellation forms — stripping them would corrupt real names.
    expect(normalizeAppellation('VQA Ontario')).toBe('VQA Ontario');      // leading VQA is the official form
    expect(normalizeAppellation('Wine of Origin Western Cape')).toBe('Wine of Origin Western Cape');
    expect(normalizeAppellation('Kamptal DAC')).toBe('Kamptal DAC');      // DAC deliberately not a tier token
    expect(normalizeAppellation('Vin de France')).toBe('Vin de France');
    expect(normalizeAppellation('Muscat de Beaumes-de-Venise')).toBe('Muscat de Beaumes-de-Venise');
  });
});

describe('stripTrailingVintage (registry is vintage-neutral — audit B2)', () => {
  test('strips a trailing year token, with or without separator dashes/parens', () => {
    expect(stripTrailingVintage('Reserve Cabernet Sauvignon 2023')).toBe('Reserve Cabernet Sauvignon');
    expect(stripTrailingVintage('Rioja Reserva - 2019')).toBe('Rioja Reserva');
    expect(stripTrailingVintage('Amarone (2016)')).toBe('Amarone');
    expect(stripTrailingVintage('Barolo 1996')).toBe('Barolo');
  });

  test('loops the double-stamp case', () => {
    expect(stripTrailingVintage('Bourgogne Rouge 2019 2019')).toBe('Bourgogne Rouge');
  });

  test('LEADING years are brand names and survive', () => {
    expect(stripTrailingVintage('1924 Double Black')).toBe('1924 Double Black');
    expect(stripTrailingVintage('19 Crimes')).toBe('19 Crimes');
  });

  test('years outside the 1950–2049 vintage window survive anywhere', () => {
    expect(stripTrailingVintage('Cuvée 1865')).toBe('Cuvée 1865');   // Viña San Pedro's brand
    expect(stripTrailingVintage('Reserva 1899')).toBe('Reserva 1899');
    expect(stripTrailingVintage('Anno 2077')).toBe('Anno 2077');
  });

  test('never empties the name and passes non-strings through', () => {
    expect(stripTrailingVintage('2019')).toBe('2019'); // name IS a year — honest junk beats empty
    expect(stripTrailingVintage(null)).toBeNull();
    expect(stripTrailingVintage(undefined)).toBeUndefined();
  });

  test('a mid-name year is part of the cuvée and survives', () => {
    expect(stripTrailingVintage('Cuvée 2000 Réserve')).toBe('Cuvée 2000 Réserve');
  });
});

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

// ─── isRecognizedCountry ─────────────────────────────────────────────────────

describe('isRecognizedCountry', () => {
  test('false for falsy/blank input', () => {
    expect(isRecognizedCountry(null)).toBe(false);
    expect(isRecognizedCountry('')).toBe(false);
    expect(isRecognizedCountry('   ')).toBe(false);
  });

  test('true for canonical names regardless of case and diacritics', () => {
    expect(isRecognizedCountry('Spain')).toBe(true);
    expect(isRecognizedCountry('spain')).toBe(true);
    expect(isRecognizedCountry('FRANCE')).toBe(true);
    expect(isRecognizedCountry('Türkiye')).toBe(true);
    expect(isRecognizedCountry("Côte d'Ivoire")).toBe(true);
  });

  test('true through the alias layer (localized names resolve first)', () => {
    expect(isRecognizedCountry('Tyskland')).toBe(true);       // sv → Germany
    expect(isRecognizedCountry('España')).toBe(true);         // → Spain
    expect(isRecognizedCountry('United Kingdom')).toBe(true); // → England
    expect(isRecognizedCountry('USA')).toBe(true);            // → United States
  });

  test('true for real countries missing from the seeded taxonomy (India may be minted)', () => {
    expect(isRecognizedCountry('India')).toBe(true);
    expect(isRecognizedCountry('Thailand')).toBe(true);
    expect(isRecognizedCountry('Uzbekistan')).toBe(true);
  });

  test('false for the prod junk this gate exists to stop', () => {
    expect(isRecognizedCountry('Espalda')).toBe(false); // misread "España" (ticket 2026-07-26)
    expect(isRecognizedCountry('Atlantis')).toBe(false);
    expect(isRecognizedCountry('Back label')).toBe(false);
    expect(isRecognizedCountry('Red')).toBe(false);
  });

  test('every canonical COUNTRY_ALIASES target is itself recognized (no alias can dead-end)', () => {
    // Sample the targets rather than exporting the private map: each canonical
    // value used in resolveCountryName's own tests above must pass the gate.
    for (const target of [
      'United States', 'England', 'Germany', 'Italy', 'France', 'Spain',
      'New Zealand', 'Austria', 'South Africa', 'Czech Republic',
      'Netherlands', 'Turkey', 'Russian Federation', 'Moldova', 'Denmark',
    ]) {
      expect(isRecognizedCountry(target)).toBe(true);
    }
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

describe('resolveGrapeName — blend-percentage artifacts (taxonomy audit 2026-07-18)', () => {
  test('strips a leading percentage and resolves the remainder', () => {
    // "70% Monastrell" existed as a Grape document on prod
    expect(resolveGrapeName('70% Monastrell')).toBe('Mourvèdre');
    expect(resolveGrapeName('25% Cabernet Sauvignon')).toBe('Cabernet Sauvignon');
    expect(resolveGrapeName('5%Merlot')).toBe('Merlot');
  });

  test('strips a trailing percentage too', () => {
    expect(resolveGrapeName('Monastrell 70%')).toBe('Mourvèdre');
    expect(resolveGrapeName('Merlot 5 %')).toBe('Merlot');
  });

  test('a bare percentage strips to empty (caller drops it)', () => {
    expect(resolveGrapeName('70%')).toBe('');
  });

  test('does not touch percentages inside a name', () => {
    expect(resolveGrapeName('Syrah')).toBe('Syrah');
  });

  // CodeQL js/polynomial-redos #199. Grape names arrive from label scan, import
  // files and AI output, so the input is not trusted. With unbounded `\s*` the
  // trailing-percentage pattern rescanned the whole run of spaces from every
  // start index; 50k spaces took seconds. Bounded {0,3} makes it linear.
  test('a long run of whitespace cannot make the percentage strip quadratic', () => {
    const hostile = `${' '.repeat(50000)}x`;
    const start = process.hrtime.bigint();
    expect(resolveGrapeName(hostile)).toBe('x'); // .trim() leaves just the x
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(250);
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

describe('producer house prefixes (the launch-day Barolo duplicate)', () => {
  const { tokenSimilarity, combinedSimilarity } = require('./normalize');

  test('"Cantina Bartolo Mascarello" tokens equal "Bartolo Mascarello"', () => {
    expect(tokenSimilarity('Cantina Bartolo Mascarello', 'Bartolo Mascarello')).toBe(1);
    expect(tokenSimilarity('Azienda Agricola Montevertine', 'Montevertine')).toBe(1);
    expect(tokenSimilarity('Tenuta San Guido', 'San Guido')).toBe(1);
    expect(tokenSimilarity('Weingut Keller', 'Keller')).toBe(1);
  });

  test('combined producer similarity clears the resolver soft zone', () => {
    // With name (0.45) and appellation (0.10) identical, the wine-level score
    // is 0.55 + 0.45 × producerSim — producerSim ≥ 0.75 puts the pair at
    // ≥ 0.8875, safely above SOFT_ZONE_MIN (0.85), so the resolver surfaces
    // "did you mean?" instead of silently minting a duplicate. Before the
    // stop-word fix this pair scored ~0.65 and fell through to no_match.
    expect(combinedSimilarity('Cantina Bartolo Mascarello', 'Bartolo Mascarello')).toBeGreaterThanOrEqual(0.75);
  });

  test('distinct producers do NOT collapse to auto-match territory', () => {
    // Sharing a stripped prefix must not make different houses near-identical:
    // candidates at worst (soft zone asks the user), never a silent merge.
    expect(combinedSimilarity('Cantina Rossi', 'Cantina Bianchi')).toBeLessThan(0.6);
  });
});

describe('normalizeProducerKey (ticket #2B: dup-cluster bucketing)', () => {
  test('a corporate suffix + a wine stop word collapse to the same key', () => {
    // The exact repro: two registry strings for one producer must bucket together.
    expect(normalizeProducerKey('Kumeu River Wines Limited')).toBe('kumeu river');
    expect(normalizeProducerKey('Kumeu River')).toBe('kumeu river');
  });

  test('common legal forms are stripped', () => {
    expect(normalizeProducerKey('Foo Bar Ltd')).toBe(normalizeProducerKey('Foo Bar'));
    expect(normalizeProducerKey('Weingut Müller GmbH')).toBe(normalizeProducerKey('Müller'));
  });

  test('genuinely different producers keep different keys', () => {
    expect(normalizeProducerKey('Kumeu River')).not.toBe(normalizeProducerKey('Cloudy Bay'));
  });

  test('empty / all-stopword producer yields an empty key (bucket skipped)', () => {
    expect(normalizeProducerKey('')).toBe('');
    expect(normalizeProducerKey('Wines Ltd')).toBe('');
  });
});

describe('normalizeProducerKey — Saint fold + founding-year strip (tickets d49fea22 / d49dfd38)', () => {
  test('St / Ste / Saint / Sainte share one bucket token — the Caronne 3-spelling split', () => {
    const key = normalizeProducerKey('Château Caronne Sainte Gemme');
    expect(key).toBe('caronne saint gemme');
    expect(normalizeProducerKey('Château Caronne Ste Gemme')).toBe(key);
    expect(normalizeProducerKey('Chateau Caronne Saint Gemme')).toBe(key);
  });

  test('folds at any token position, not just leading', () => {
    expect(normalizeProducerKey('St Hallett')).toBe('saint hallett');
    expect(normalizeProducerKey('Mount St John')).toBe('mount saint john');
    expect(normalizeProducerKey('Chateau Ste Michelle')).toBe(normalizeProducerKey('Chateau Sainte Michelle'));
  });

  test('a trailing founding year is a date, not producer identity', () => {
    expect(normalizeProducerKey("Grand Pappy's 1846")).toBe(normalizeProducerKey("Grand Pappy's"));
    expect(normalizeProducerKey("Grand Pappy's Est. 1846")).toBe('grand pappys');
    expect(normalizeProducerKey('Bodega Norton Anno 1895')).toBe('norton');
  });

  test('a LEADING year is a brand name and survives — even when the tail is a stop word', () => {
    // tokenize() drops 'winery', which would leave the brand year LOOKING
    // trailing — this pins that position is judged on the raw string.
    expect(normalizeProducerKey('1848 Winery')).toBe('1848');
  });

  test('a stop/corp word after the founding year does not hide it (audit 2026-08-10)', () => {
    // Pre-fix, "X 1846" and "X 1846 Winery" split into different keys — a
    // regression against the pre-fold bucketing, which unified them.
    expect(normalizeProducerKey("Grand Pappy's 1846 Winery")).toBe('grand pappys');
    expect(normalizeProducerKey('Bodega Norton 1895 Ltd')).toBe('norton');
    expect(normalizeProducerKey("Grand Pappy's Est. 1846 Winery")).toBe('grand pappys');
    // The leading-brand-year rule still wins over the walk-back.
    expect(normalizeProducerKey('1848 Winery')).toBe('1848');
  });

  test('a producer that IS only a year keys empty — callers fall back to the raw string', () => {
    // wineIdentity.producerSegment and wineMatching.producerSimilarity both
    // fall back to normalizeString on an empty key, so bare-year producers
    // stay distinct from each other instead of sharing one canonical bucket.
    expect(normalizeProducerKey('1846')).toBe('');
    expect(normalizeProducerKey('Est. 1846')).toBe('');
  });

  test('corp-suffix stripping still works alongside both folds', () => {
    expect(normalizeProducerKey('St Hallett Wines Ltd')).toBe('saint hallett');
    expect(normalizeProducerKey('Kumeu River Wines Limited')).toBe('kumeu river');
  });
});
