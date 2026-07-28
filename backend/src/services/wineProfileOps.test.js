const {
  validateProfilePatch,
  applyProfilePatch,
  snapshotProfile,
  restoreProfile,
  EDITABLE_FIELDS,
} = require('./wineProfileOps');

// A stand-in for a mongoose doc: only markModified is behaviour we rely on.
const fakeWine = (aiProfile = {}, profileReviewedAt = null) => ({
  aiProfile: { ...aiProfile },
  profileReviewedAt,
  markModified: jest.fn(),
});

describe('validateProfilePatch', () => {
  test('an empty patch is rejected — a no-op write would still flip provenance', () => {
    const r = validateProfilePatch({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least one of/);
  });

  test('rejects a non-object', () => {
    expect(validateProfilePatch(null).ok).toBe(false);
    expect(validateProfilePatch([]).ok).toBe(false);
    expect(validateProfilePatch('full').ok).toBe(false);
  });

  test.each([
    ['body', 'full', 'enormous'],
    ['tannin', 'high', 'grippy'],
    ['acidity', 'low', 'zingy'],
    ['sweetness', 'off-dry', 'medium-dry'],
  ])('%s accepts its own vocabulary and nothing else', (field, good, bad) => {
    expect(validateProfilePatch({ [field]: good })).toEqual({ ok: true, clean: { [field]: good } });
    expect(validateProfilePatch({ [field]: bad }).ok).toBe(false);
  });

  test('an absent key is untouched; an explicit null clears (field-level abstention)', () => {
    const r = validateProfilePatch({ description: null });
    expect(r.clean).toEqual({ description: null });
    expect(r.clean).not.toHaveProperty('body'); // absent stays absent

    // Lists clear to [] rather than null, matching the schema default.
    expect(validateProfilePatch({ flavors: null }).clean).toEqual({ flavors: [] });
  });

  test('markdown is stripped from the description at the write point', () => {
    // Same reason enrichmentJob strips it: MCP get_wine serves this verbatim.
    expect(validateProfilePatch({ description: 'A **bold** claim' }).clean.description)
      .toBe('A bold claim');
  });

  test('an all-whitespace description becomes null, not an empty string', () => {
    expect(validateProfilePatch({ description: '   ' }).clean.description).toBeNull();
  });

  test('description length is capped', () => {
    expect(validateProfilePatch({ description: 'x'.repeat(1001) }).ok).toBe(false);
    expect(validateProfilePatch({ description: 'x'.repeat(1000) }).ok).toBe(true);
  });

  test('lists are trimmed, de-duplicated case-insensitively, and length-capped', () => {
    const r = validateProfilePatch({ flavors: ['  dried fig ', 'Dried Fig', 'walnut'] });
    expect(r.clean.flavors).toEqual(['dried fig', 'walnut']);

    const eleven = Array.from({ length: 11 }, (_, i) => `flavour ${i}`);
    expect(validateProfilePatch({ flavors: eleven }).ok).toBe(false);
    // …but 11 copies of one value dedupe to a single legal entry.
    expect(validateProfilePatch({ flavors: Array(11).fill('fig') }).clean.flavors).toEqual(['fig']);
  });

  test('rejects a non-string list member and an over-long one', () => {
    expect(validateProfilePatch({ flavors: [1] }).ok).toBe(false);
    expect(validateProfilePatch({ flavors: ['x'.repeat(41)] }).ok).toBe(false);
  });

  test('generator-owned fields are not editable', () => {
    // confidence/model/generatedAt describe the AI run; producerSuspect feeds
    // the separate admin queue. None may be written by a curator.
    for (const f of ['confidence', 'model', 'generatedAt', 'producerSuspect', 'source']) {
      expect(EDITABLE_FIELDS).not.toContain(f);
      expect(validateProfilePatch({ [f]: 'x' }).ok).toBe(false); // nothing editable was supplied
    }
  });
});

describe('applyProfilePatch', () => {
  test('stamps provenance and clears the low-confidence queue', () => {
    const wine = fakeWine({ body: 'light', description: 'wrong', confidence: 0.6, source: 'ai' });
    const now = new Date('2026-07-28T12:00:00Z');

    applyProfilePatch(wine, { description: 'right' }, 'user-1', { now });

    expect(wine.aiProfile.description).toBe('right');
    expect(wine.aiProfile.source).toBe('curator');
    expect(wine.aiProfile.verifiedBy).toBe('user-1');
    expect(wine.aiProfile.verifiedAt).toBe(now);
    // A human has now looked at exactly what that queue asks a human to look at.
    expect(wine.profileReviewedAt).toBe(now);
    expect(wine.markModified).toHaveBeenCalledWith('aiProfile');
  });

  test('leaves untouched fields alone and preserves the AI confidence value', () => {
    const wine = fakeWine({ body: 'light', tannin: 'low', confidence: 0.6 });
    applyProfilePatch(wine, { body: 'full' }, 'user-1');
    expect(wine.aiProfile.body).toBe('full');
    expect(wine.aiProfile.tannin).toBe('low');
    // Kept as forensics of what the generator claimed; the UI hides it once
    // source is 'curator' rather than the model pretending to have rated a
    // human's work.
    expect(wine.aiProfile.confidence).toBe(0.6);
  });

  test('works on a wine that has no profile at all', () => {
    const wine = { profileReviewedAt: null, markModified: jest.fn() };
    applyProfilePatch(wine, { body: 'full' }, 'user-1');
    expect(wine.aiProfile.body).toBe('full');
    expect(wine.aiProfile.source).toBe('curator');
  });
});

describe('snapshot / restore (the undo_last contract)', () => {
  test('a round trip restores values AND provenance', () => {
    const wine = fakeWine({
      body: 'light', tannin: 'low', acidity: 'high', sweetness: 'dry',
      flavors: ['citrus'], foodPairings: ['oysters'],
      description: 'the original', source: 'ai', confidence: 0.6,
    });
    const snap = snapshotProfile(wine);

    applyProfilePatch(wine, { description: 'corrected', flavors: ['fig'] }, 'user-1');
    expect(wine.aiProfile.source).toBe('curator');

    restoreProfile(wine, snap);

    expect(wine.aiProfile.description).toBe('the original');
    expect(wine.aiProfile.flavors).toEqual(['citrus']);
    // Provenance must come back too: undoing a correction hands the row back
    // to enrichmentJob exactly as it was, eligible for regeneration again.
    expect(wine.aiProfile.source).toBe('ai');
    expect(wine.aiProfile.verifiedBy).toBeNull();
    expect(wine.profileReviewedAt).toBeNull();
  });

  test('the snapshot is a copy — later mutation cannot corrupt it', () => {
    const wine = fakeWine({ flavors: ['citrus'], source: 'ai' });
    const snap = snapshotProfile(wine);
    wine.aiProfile.flavors.push('oak');
    expect(snap.flavors).toEqual(['citrus']);
  });

  test('restoring onto a wine whose profile was cleared still works', () => {
    const wine = fakeWine({ description: 'original', source: 'ai' });
    const snap = snapshotProfile(wine);
    wine.aiProfile = {};
    restoreProfile(wine, snap);
    expect(wine.aiProfile.description).toBe('original');
    expect(wine.aiProfile.source).toBe('ai');
  });
});
