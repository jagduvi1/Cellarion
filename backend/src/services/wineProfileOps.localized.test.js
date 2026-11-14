/**
 * Curator writes, undo and the translated copy of the prose
 * (utils/profileLanguage).
 *
 * WHY THIS TEST EXISTS:
 * A copy is shown while its generatedAt equals the profile's. A curator's
 * set_wine_profile (REST and MCP, applyProfilePatch) and its undo
 * (restoreProfile) rewrite the English WITHOUT a new generatedAt — so here the
 * copy must go whenever the prose it translates changed, or the page would
 * show a translation of text that is no longer there. A write that leaves
 * the prose as it was (structure, serving temperature, the same text sent
 * again) keeps it. The real-model behaviour (the save that follows) was
 * checked against MongoDB; these pin the decision.
 */
const { applyProfilePatch, restoreProfile, snapshotProfile } = require('./wineProfileOps');

const AT = new Date('2026-11-13T10:00:00Z');
const COPY = { lang: 'de', description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten'], generatedAt: AT };

// A stand-in for a mongoose doc, as in wineProfileOps.test.js.
const fakeWine = () => ({
  aiProfile: {
    body: 'full', tannin: 'high', acidity: 'high', sweetness: 'dry',
    flavors: ['tar', 'rose'], foodPairings: ['braised beef'], description: 'Firm and fragrant.',
    source: 'ai', confidence: 0.8, generatedAt: AT, heldAt: null, localized: { ...COPY },
  },
  profileReviewedAt: null,
  markModified: jest.fn(),
});

describe('applyProfilePatch', () => {
  test.each([
    ['a new description', { description: 'Rewritten by a curator.' }],
    ['new flavours', { flavors: ['tar', 'violet'] }],
    ['new pairings', { foodPairings: ['truffle risotto'] }],
    ['a cleared description', { description: null }],
  ])('%s drops the copy; generatedAt stays as it was', (_, patch) => {
    const wine = fakeWine();
    applyProfilePatch(wine, patch, 'user-1');
    expect(wine.aiProfile.localized).toBeUndefined();
    expect(wine.aiProfile.generatedAt).toBe(AT);
  });

  test.each([
    ['a structure change', { body: 'medium', tannin: 'medium' }],
    ['the serving temperature', { servingTempMin: 16, servingTempMax: 18 }],
    ['the same prose sent again', { description: 'Firm and fragrant.', flavors: ['tar', 'rose'], foodPairings: ['braised beef'] }],
  ])('%s keeps the copy: the prose it translates is unchanged', (_, patch) => {
    const wine = fakeWine();
    applyProfilePatch(wine, patch, 'user-1');
    expect(wine.aiProfile.localized).toEqual(COPY);
  });

  test('a wine with no copy gets none: the write is the write it always was', () => {
    const wine = fakeWine();
    delete wine.aiProfile.localized;
    applyProfilePatch(wine, { description: 'Rewritten by a curator.' }, 'user-1');
    expect(wine.aiProfile).not.toHaveProperty('localized');
  });
});

describe('restoreProfile (undo)', () => {
  test('restoring other prose drops a copy made of the prose being replaced', () => {
    const wine = fakeWine();
    const snap = snapshotProfile({ ...wine, aiProfile: { ...wine.aiProfile, description: 'The text before.' } });
    restoreProfile(wine, snap);
    expect(wine.aiProfile.description).toBe('The text before.');
    expect(wine.aiProfile.localized).toBeUndefined();
  });

  test('restoring the same prose (the undo of a structure-only edit) keeps it', () => {
    const wine = fakeWine();
    const snap = snapshotProfile(wine);
    applyProfilePatch(wine, { body: 'light' }, 'user-1');
    restoreProfile(wine, snap);
    expect(wine.aiProfile.body).toBe('full');
    expect(wine.aiProfile.localized).toEqual(COPY);
  });
});
