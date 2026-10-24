// The hold half of the undo_last contract: applyProfilePatch ends a hold
// (heldAt → null), so snapshotProfile/restoreProfile must carry heldAt and
// heldReason or an undo silently drops the wine out of the held queue.
jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));

const { applyProfilePatch, snapshotProfile, restoreProfile } = require('./wineProfileOps');

// A stand-in for a mongoose doc: only markModified is behaviour we rely on.
const fakeWine = (aiProfile = {}, profileReviewedAt = null) => ({
  aiProfile: { ...aiProfile },
  profileReviewedAt,
  markModified: jest.fn(),
});

// What a held row stores: the doubt and its meta, no prose or axes.
const heldProfile = (heldAt) => ({
  body: null, tannin: null, acidity: null, sweetness: null,
  flavors: [], foodPairings: [], description: null,
  source: 'ai', confidence: 0.3, generatedAt: new Date('2026-08-17T10:00:00Z'),
  heldAt, heldReason: 'low_confidence',
});

describe('snapshot / restore keep a hold', () => {
  test('a held row survives patch + restore', () => {
    const heldAt = new Date('2026-08-18T09:00:00Z');
    const wine = fakeWine(heldProfile(heldAt));
    const snap = snapshotProfile(wine);
    expect(snap.heldAt).toEqual(heldAt);
    expect(snap.heldReason).toBe('low_confidence');

    applyProfilePatch(wine, { description: 'x' }, 'user-1');
    expect(wine.aiProfile.heldAt).toBeNull(); // the write ended the hold

    restoreProfile(wine, snap);
    expect(wine.aiProfile.heldAt).toEqual(heldAt);
    expect(wine.aiProfile.heldReason).toBe('low_confidence');
    expect(wine.aiProfile.description).toBeNull();
    expect(wine.aiProfile.source).toBe('ai');
    expect(wine.aiProfile.verifiedBy).toBeNull();
    expect(wine.profileReviewedAt).toBeNull();
  });

  test('a snapshot read back from the ledger (dates as strings) restores heldAt as a Date', () => {
    const heldAt = new Date('2026-08-18T09:00:00Z');
    const wine = fakeWine(heldProfile(heldAt));
    const snap = JSON.parse(JSON.stringify(snapshotProfile(wine)));
    applyProfilePatch(wine, { description: 'x' }, 'user-1');

    restoreProfile(wine, snap);
    expect(wine.aiProfile.heldAt).toBeInstanceOf(Date);
    expect(wine.aiProfile.heldAt.getTime()).toBe(heldAt.getTime());
    expect(wine.aiProfile.heldReason).toBe('low_confidence');
  });

  test('a row that was not held stays un-held after the undo', () => {
    const wine = fakeWine({ description: 'the original', source: 'ai', heldAt: null, heldReason: null });
    const snap = snapshotProfile(wine);
    expect(snap.heldAt).toBeNull();
    expect(snap.heldReason).toBeNull();

    applyProfilePatch(wine, { description: 'corrected' }, 'user-1');
    restoreProfile(wine, snap);
    expect(wine.aiProfile.heldAt).toBeNull();
    expect(wine.aiProfile.heldReason).toBeNull();
    expect(wine.aiProfile.description).toBe('the original');
  });

  test('a pre-feature snapshot without heldAt leaves heldAt alone', () => {
    const unheld = fakeWine({ description: 'x', source: 'curator', heldAt: null });
    restoreProfile(unheld, { description: 'y', source: 'ai' }); // old ledger prev
    expect(unheld.aiProfile.heldAt).toBeNull();

    const heldAt = new Date('2026-08-18T09:00:00Z');
    const held = fakeWine(heldProfile(heldAt));
    restoreProfile(held, { description: 'y', source: 'ai' });
    expect(held.aiProfile.heldAt).toEqual(heldAt);
    expect(held.aiProfile.heldReason).toBe('low_confidence');
  });
});
