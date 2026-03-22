const { scoreWineMatch, findBestMatch, WEIGHTS } = require('./wineMatching');

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
