const { scoreWineMatch, findBestMatch, scoreAllMatches, WEIGHTS } = require('./wineMatching');

// ─── scoreWineMatch ──────────────────────────────────────────────────────────

describe('scoreWineMatch', () => {
  test('exact match scores close to 1.0', () => {
    const wine = { name: 'Grand Cru', producer: 'Domaine Leflaive', appellation: 'Puligny-Montrachet' };
    const query = { name: 'Grand Cru', producer: 'Domaine Leflaive', appellation: 'Puligny-Montrachet' };
    const score = scoreWineMatch(wine, query);
    expect(score).toBeGreaterThan(0.95);
  });

  test('completely different wines score low', () => {
    const candidate = { name: 'Opus One', producer: 'Mondavi Rothschild', appellation: 'Napa Valley' };
    const query = { name: 'Cloudy Bay Sauvignon Blanc', producer: 'LVMH Estates', appellation: 'Marlborough' };
    const score = scoreWineMatch(candidate, query);
    expect(score).toBeLessThan(0.3);
  });

  test('both sides missing appellation with redistribute=true (default)', () => {
    const candidate = { name: 'Merlot', producer: 'Silver Oak' };
    const query = { name: 'Merlot', producer: 'Silver Oak' };
    // redistribute=true: appellation weight is redistributed to name+producer
    // score = nameScore*0.45 + producerScore*0.45 + (nameScore*0.05 + producerScore*0.05)
    // = nameScore*0.50 + producerScore*0.50
    const score = scoreWineMatch(candidate, query, { redistribute: true });
    expect(score).toBeGreaterThan(0.95);
  });

  test('both sides missing appellation with redistribute=false', () => {
    const candidate = { name: 'Merlot', producer: 'Silver Oak' };
    const query = { name: 'Merlot', producer: 'Silver Oak' };
    // redistribute=false: absence is a perfect match → full appellation weight (0.10)
    // score = nameScore*0.45 + producerScore*0.45 + 1.0*0.10
    const score = scoreWineMatch(candidate, query, { redistribute: false });
    expect(score).toBeGreaterThan(0.95);
  });

  test('redistribute=true and redistribute=false produce different scores for non-perfect name/producer', () => {
    // With slightly different names, the redistribution path adds nameScore*0.05 + producerScore*0.05
    // while the non-redistribute path adds a flat 1.0*0.10
    const candidate = { name: 'Chardonnay Reserve', producer: 'Beringer' };
    const query = { name: 'Chardonnay', producer: 'Beringer Vineyards' };
    const scoreRedist = scoreWineMatch(candidate, query, { redistribute: true });
    const scoreNoRedist = scoreWineMatch(candidate, query, { redistribute: false });
    expect(scoreRedist).not.toBeCloseTo(scoreNoRedist, 5);
  });

  test('one side has appellation, other does not (0.5 penalty)', () => {
    const candidate = { name: 'Pinot Noir', producer: 'Domaine Drouhin', appellation: 'Willamette Valley' };
    const query = { name: 'Pinot Noir', producer: 'Domaine Drouhin' };
    const score = scoreWineMatch(candidate, query);
    // The appellation component should be 0.5 * WEIGHTS.appellation = 0.05
    // With both having appellation, it would be higher (appSimilarity * 0.10)
    // With neither (redistribute), it would be nameScore*0.05 + producerScore*0.05
    // The penalty path is deterministic: always adds 0.05
    const candidateBoth = { name: 'Pinot Noir', producer: 'Domaine Drouhin', appellation: 'Willamette Valley' };
    const queryBoth = { name: 'Pinot Noir', producer: 'Domaine Drouhin', appellation: 'Willamette Valley' };
    const scoreBoth = scoreWineMatch(candidateBoth, queryBoth);
    expect(score).toBeLessThan(scoreBoth);
  });

  test('both have appellation — appellation similarity contributes to score', () => {
    const candidate = { name: 'Barolo', producer: 'Giacomo Conterno', appellation: 'Barolo DOCG' };
    const query = { name: 'Barolo', producer: 'Giacomo Conterno', appellation: 'Barolo DOCG' };
    const score = scoreWineMatch(candidate, query);
    // Identical appellation → full appellation weight contributes
    expect(score).toBeGreaterThan(0.95);

    // Different appellations lower the score
    const queryDiffApp = { name: 'Barolo', producer: 'Giacomo Conterno', appellation: 'Barbaresco DOCG' };
    const scoreDiffApp = scoreWineMatch(candidate, queryDiffApp);
    expect(scoreDiffApp).toBeLessThan(score);
  });

  test('score is always between 0 and 1', () => {
    const candidate = { name: 'Riesling Spatlese', producer: 'Dr. Loosen', appellation: 'Mosel' };
    const query = { name: 'Zinfandel', producer: 'Ridge Vineyards', appellation: 'Sonoma' };
    const score = scoreWineMatch(candidate, query);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('empty/falsy appellation treated as missing', () => {
    const candidate = { name: 'Merlot', producer: 'Silver Oak', appellation: '' };
    const query = { name: 'Merlot', producer: 'Silver Oak', appellation: '' };
    // Both empty strings → Boolean('') is false → redistribute branch
    const score = scoreWineMatch(candidate, query);
    expect(score).toBeGreaterThan(0.95);
  });
});

// ─── producer variants — comparison-key axis (dup analysis 2026-07-22) ──────

describe('scoreWineMatch — producer variants', () => {
  test('corporate-suffix variant of the same producer scores as an exact producer match', () => {
    // Raw-string comparison used to score this ~0.77 — below the soft zone, so
    // the duplicate was created silently. Key comparison makes it auto-match.
    const candidate = { name: "Mate's Vineyard Chardonnay", producer: 'Kumeu River', appellation: 'Kumeu' };
    const query = { name: "Mate's Vineyard Chardonnay", producer: 'Kumeu River Wines Limited', appellation: 'Kumeu' };
    expect(scoreWineMatch(candidate, query)).toBeGreaterThanOrEqual(0.95);
  });

  test('house-prefix variant (Weingut …) scores as the same producer', () => {
    const candidate = { name: 'Grüner Veltliner', producer: 'Steininger', appellation: 'Kamptal' };
    const query = { name: 'Grüner Veltliner', producer: 'Weingut Steininger', appellation: 'Kamptal' };
    expect(scoreWineMatch(candidate, query)).toBeGreaterThanOrEqual(0.95);
  });

  test('shared producer key but different appellation lands in the ASK zone, not auto-match', () => {
    // The Garden Spritz shape: two REAL wineries share the key "chandon".
    // The differing appellation must keep this under 0.95 so callers ask
    // instead of silently linking two distinct wineries.
    const candidate = { name: 'Garden Spritz', producer: 'Domaine Chandon', appellation: 'Napa Valley' };
    const query = { name: 'Garden Spritz', producer: 'Bodegas Chandon', appellation: 'Mendoza' };
    const score = scoreWineMatch(candidate, query);
    expect(score).toBeLessThan(0.95);
    expect(score).toBeGreaterThanOrEqual(0.85);
  });

  test('genuinely different producers still score far apart', () => {
    const candidate = { name: 'Pinot Noir', producer: 'Felton Road', appellation: 'Bannockburn' };
    const query = { name: 'Pinot Noir', producer: 'Cloudy Bay', appellation: 'Bannockburn' };
    expect(scoreWineMatch(candidate, query)).toBeLessThan(0.85);
  });
});

// ─── findBestMatch ───────────────────────────────────────────────────────────

describe('findBestMatch', () => {
  const candidates = [
    { name: 'Opus One', producer: 'Mondavi Rothschild', appellation: 'Napa Valley' },
    { name: 'Cloudy Bay Sauvignon Blanc', producer: 'LVMH', appellation: 'Marlborough' },
    { name: 'Barolo Riserva', producer: 'Giacomo Conterno', appellation: 'Barolo DOCG' },
  ];

  test('returns the best candidate', () => {
    const query = { name: 'Opus One', producer: 'Mondavi Rothschild', appellation: 'Napa Valley' };
    const { bestMatch, bestScore } = findBestMatch(query, candidates);
    expect(bestMatch).toBe(candidates[0]);
    expect(bestScore).toBeGreaterThan(0.9);
  });

  test('returns the closest candidate even for imperfect match', () => {
    const query = { name: 'Barolo', producer: 'Giacomo Conterno', appellation: 'Barolo' };
    const { bestMatch } = findBestMatch(query, candidates);
    expect(bestMatch).toBe(candidates[2]);
  });

  test('with empty candidates returns null and 0', () => {
    const query = { name: 'Merlot', producer: 'Somewhere' };
    const { bestMatch, bestScore } = findBestMatch(query, []);
    expect(bestMatch).toBeNull();
    expect(bestScore).toBe(0);
  });

  test('passes opts through to scoreWineMatch', () => {
    const candidatesNoApp = [
      { name: 'Merlot', producer: 'Silver Oak' },
      { name: 'Cabernet', producer: 'Silver Oak' },
    ];
    const query = { name: 'Merlot', producer: 'Silver Oak' };
    const { bestMatch: matchRedist } = findBestMatch(query, candidatesNoApp, { redistribute: true });
    const { bestMatch: matchNoRedist } = findBestMatch(query, candidatesNoApp, { redistribute: false });
    // Both should find the same best match regardless of redistribute
    expect(matchRedist.name).toBe('Merlot');
    expect(matchNoRedist.name).toBe('Merlot');
  });
});

// ─── scoreAllMatches ─────────────────────────────────────────────────────────

describe('scoreAllMatches', () => {
  const candidates = [
    { name: 'Rosabella Rosato', producer: 'G.D. Vajra' },
    { name: 'Rosa Bella', producer: 'G.D. Vajra' },
    { name: 'Opus One', producer: 'Mondavi Rothschild' },
  ];

  test('returns all candidates with scores, sorted desc', () => {
    const query = { name: 'Rosabella', producer: 'G.D. Vajra' };
    const ranked = scoreAllMatches(query, candidates, { redistribute: false });
    expect(ranked).toHaveLength(3);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
    expect(ranked[2].wine.name).toBe('Opus One'); // least similar last
  });

  test('preserves the candidate object reference on each entry', () => {
    const query = { name: 'Opus One', producer: 'Mondavi Rothschild' };
    const ranked = scoreAllMatches(query, candidates);
    expect(ranked[0].wine).toBe(candidates[2]);
  });

  test('empty candidates returns empty array', () => {
    expect(scoreAllMatches({ name: 'X', producer: 'Y' }, [])).toEqual([]);
  });
});

// ─── WEIGHTS constant ────────────────────────────────────────────────────────

describe('WEIGHTS', () => {
  test('weights sum to 1.0', () => {
    const sum = WEIGHTS.name + WEIGHTS.producer + WEIGHTS.appellation;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  test('has expected structure', () => {
    expect(WEIGHTS).toEqual({ name: 0.45, producer: 0.45, appellation: 0.10 });
  });
});

// ─── Name-abbreviation expansion (scan bench 2026-07-29) ─────────────────────

describe('scoreWineMatch — label abbreviation expansion', () => {
  // The prod-photo scan bench measured every German GG label under the 0.75
  // match floor purely on the "GG" vs "Großes Gewächs" token. The expansion is
  // comparison-layer only — stored strings and keys never change.
  test('GG on the label matches Großes Gewächs in the registry', () => {
    const score = scoreWineMatch(
      { name: 'Riesling Philippsbrunnen Großes Gewächs', producer: 'Weingut Philipp Kuhn' },
      { name: 'Philippsbrunnen GG Riesling', producer: 'Philipp Kuhn' },
      { redistribute: false }
    );
    expect(score).toBeGreaterThanOrEqual(0.85);
  });

  test('1er on the label matches Premier in the registry', () => {
    const score = scoreWineMatch(
      { name: 'Pouilly-Fuissé Premier Cru La Maréchaude', producer: 'Domaine Barraud' },
      { name: 'Pouilly-Fuissé 1er Cru La Maréchaude', producer: 'Domaine Barraud' },
      { redistribute: false }
    );
    expect(score).toBeGreaterThanOrEqual(0.95);
  });

  test('the expansion never fires inside a word', () => {
    // "Eggenburg" must not become "Egroes gewachsenburg".
    const same = scoreWineMatch(
      { name: 'Eggenburg Riesling', producer: 'X' },
      { name: 'Eggenburg Riesling', producer: 'X' },
      { redistribute: false }
    );
    expect(same).toBeCloseTo(1.0, 5);
  });
});
