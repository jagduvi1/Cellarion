/**
 * Registry lockdown L3 — anonymous callers get prose, members get the dataset.
 */
const { styleSentence, publicProfileSummary, tierWinePayload } = require('./registryTiering');

const FULL = {
  description: 'Dark cherry, tar and roses over firm, fine-grained tannin.',
  body: 'full', tannin: 'firm', acidity: 'high', sweetness: 'dry',
  flavors: ['cherry', 'tar', 'rose'], foodPairings: ['braised beef'],
  confidence: 0.82, source: 'curator', model: 'claude-x', generatedAt: '2026-08-01T00:00:00Z',
};

describe('styleSentence', () => {
  test('joins the structure fields in reading order', () => {
    expect(styleSentence(FULL)).toBe('full-bodied, firm tannin, high acidity, dry');
  });
  test('skips missing fields and returns null when there is no structure', () => {
    expect(styleSentence({ body: 'light' })).toBe('light-bodied');
    expect(styleSentence({ description: 'x' })).toBeNull();
    expect(styleSentence(null)).toBeNull();
  });
});

describe('publicProfileSummary', () => {
  test('keeps the prose, the style line and the provenance — nothing else', () => {
    expect(publicProfileSummary(FULL)).toEqual({
      description: FULL.description,
      style: 'full-bodied, firm tannin, high acidity, dry',
      source: 'curator',
    });
  });
  test('the structured arrays and numbers never leak', () => {
    const out = publicProfileSummary(FULL);
    for (const k of ['flavors', 'foodPairings', 'body', 'tannin', 'acidity', 'sweetness', 'confidence', 'model', 'generatedAt']) {
      expect(out).not.toHaveProperty(k);
    }
  });
  test('an unknown source reads as ai, never as curator', () => {
    expect(publicProfileSummary({ ...FULL, source: undefined }).source).toBe('ai');
    expect(publicProfileSummary({ ...FULL, source: 'whatever' }).source).toBe('ai');
  });
  test('no description means no public profile', () => {
    expect(publicProfileSummary({ body: 'full', flavors: ['x'] })).toBeNull();
    expect(publicProfileSummary({ description: '   ' })).toBeNull();
    expect(publicProfileSummary(null)).toBeNull();
  });
});

describe('tierWinePayload', () => {
  const wine = { name: 'Barolo', producer: 'X', aiProfile: FULL };
  test('anonymous callers get the summary', () => {
    const out = tierWinePayload(wine, { full: false });
    expect(out.aiProfile).toEqual(publicProfileSummary(FULL));
    expect(out.name).toBe('Barolo');
  });
  test('members keep the full profile, same object', () => {
    expect(tierWinePayload(wine, { full: true })).toBe(wine);
  });
  test('does not mutate the input', () => {
    tierWinePayload(wine, { full: false });
    expect(wine.aiProfile).toBe(FULL);
  });
});
