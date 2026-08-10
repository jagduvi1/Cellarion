// resolveGrapeIdsStrict is the only DB-touching function here; the rest stay
// pure. The mock lets the strict-match contract be asserted without MongoDB.
jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));

const Grape = require('../models/Grape');
const {
  validateProfilePatch,
  resolveGrapeIdsStrict,
  applyProfilePatch,
  snapshotProfile,
  restoreProfile,
  EDITABLE_FIELDS,
  WINE_TYPES,
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

  test('WINE_TYPES mirrors the WineDefinition schema enum (drift pin)', () => {
    // Hardcoded rather than read at require time (test suites mock the model
    // as a bare object) — this pin is what keeps the copies honest.
    const real = require('../models/WineDefinition').schema.path('type').enumValues;
    expect(WINE_TYPES).toEqual(real);
  });

  test('type accepts the schema vocabulary; null and strangers are refused', () => {
    expect(validateProfilePatch({ type: 'white' })).toEqual({ ok: true, clean: { type: 'white' } });
    expect(validateProfilePatch({ type: 'orange' }).ok).toBe(false);
    // Every wine has a type — there is no cleared state to return to.
    const r = validateProfilePatch({ type: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot be cleared/);
  });

  test('grapes are validated as NAMES: trimmed, deduped, capped; null clears to []', () => {
    expect(validateProfilePatch({ grapes: ['  Savagnin ', 'savagnin'] }).clean.grapes).toEqual(['Savagnin']);
    expect(validateProfilePatch({ grapes: null }).clean.grapes).toEqual([]);
    expect(validateProfilePatch({ grapes: ['x'.repeat(61)] }).ok).toBe(false);
    expect(validateProfilePatch({ grapes: Array.from({ length: 21 }, (_, i) => `g${i}`) }).ok).toBe(false);
  });
});

describe('resolveGrapeIdsStrict (match-only)', () => {
  const found = (doc) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });
  beforeEach(() => jest.clearAllMocks());

  test('resolves a synonym to its canonical taxonomy doc and echoes the display name', async () => {
    Grape.findOne.mockReturnValue(found({ _id: 'g-syrah', name: 'Syrah' }));
    const r = await resolveGrapeIdsStrict(['Shiraz']);
    expect(r).toEqual({ ok: true, ids: ['g-syrah'], names: ['Syrah'] });
    // The lookup must consult synonyms, same as findOrCreateGrapes.
    expect(Grape.findOne.mock.calls[0][0].$or).toBeDefined();
  });

  test('an unknown variety refuses the whole write — never mints taxonomy', async () => {
    Grape.findOne.mockReturnValue(found(null));
    const r = await resolveGrapeIdsStrict(['Savagnin Rose']);
    expect(r.ok).toBe(false);
    expect(r.unmatched).toEqual(['Savagnin Rose']);
  });

  test('two names resolving to one doc dedupe to a single id', async () => {
    Grape.findOne.mockReturnValue(found({ _id: 'g-syrah', name: 'Syrah' }));
    const r = await resolveGrapeIdsStrict(['Syrah', 'Shiraz']);
    expect(r.ids).toEqual(['g-syrah']);
  });

  // Audit 2026-08-10: names that normalize to '' (non-Latin scripts, bare
  // percentages) were silently DROPPED — a set became a partial write, and an
  // all-such list became an accidental clear of wine.grapes.
  test('a name that normalizes to nothing is refused, never silently dropped', async () => {
    Grape.findOne.mockReturnValue(found({ _id: 'g-syrah', name: 'Syrah' }));
    const r = await resolveGrapeIdsStrict(['Ркацители', 'Syrah']);
    expect(r.ok).toBe(false);
    expect(r.unmatched).toEqual(['Ркацители']);
    expect((await resolveGrapeIdsStrict(['Ркацители'])).ok).toBe(false);
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

  // Ticket d49ca3af: clearing a bad AI description used to curator-freeze the
  // wine, locking exactly the worst-sourced rows out of the re-enrichment that
  // would have fixed them once their real defect (null geography) was repaired.
  test('a write that ONLY clears an AI profile resets fields but does NOT verify', () => {
    const wine = fakeWine({ description: 'invented filler', body: 'full', source: 'ai', confidence: 0.3 });
    applyProfilePatch(wine, { description: null, flavors: [] }, 'user-1');
    expect(wine.aiProfile.description).toBeNull();
    expect(wine.aiProfile.flavors).toEqual([]);
    expect(wine.aiProfile.source).toBe('ai');          // still enrichment-eligible
    expect(wine.aiProfile.verifiedAt).toBeUndefined(); // nothing was verified
    expect(wine.profileReviewedAt).toBeNull();          // stays in the low-conf queue
    expect(wine.markModified).toHaveBeenCalledWith('aiProfile');
  });

  test('a clear on an already-curator profile stays curator — editing your own curated data', () => {
    const wine = fakeWine({ description: 'hand-written', foodPairings: ['oysters'], source: 'curator' });
    applyProfilePatch(wine, { foodPairings: null }, 'user-2');
    expect(wine.aiProfile.source).toBe('curator');
    expect(wine.aiProfile.verifiedBy).toBe('user-2');
  });

  test('a mixed set+clear is a curation and stamps provenance', () => {
    const wine = fakeWine({ description: 'wrong', body: 'full', source: 'ai' });
    applyProfilePatch(wine, { description: null, body: 'medium' }, 'user-1');
    expect(wine.aiProfile.source).toBe('curator');
  });

  test('type/grapes-only writes correct the record without touching profile provenance', () => {
    const wine = fakeWine({ description: 'accurate vin jaune prose', source: 'ai', confidence: 0.6 });
    wine.type = 'fortified';
    wine.grapes = [];
    applyProfilePatch(wine, { type: 'white', grapes: ['g-savagnin'] }, 'user-1');
    expect(wine.type).toBe('white');
    expect(wine.grapes).toEqual(['g-savagnin']);
    expect(wine.aiProfile.source).toBe('ai');
    expect(wine.profileReviewedAt).toBeNull();
    expect(wine.markModified).not.toHaveBeenCalled(); // aiProfile untouched
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

  test('type and grapes round-trip; populated grape docs snapshot as bare ids', () => {
    const wine = fakeWine({ source: 'ai' });
    wine.type = 'fortified';
    wine.grapes = [{ _id: 'g-1', name: 'Savagnin' }]; // populated doc shape
    const snap = snapshotProfile(wine);
    expect(snap.type).toBe('fortified');
    expect(snap.grapes).toEqual(['g-1']);

    applyProfilePatch(wine, { type: 'white', grapes: ['g-2'] }, 'user-1');
    restoreProfile(wine, snap);
    expect(wine.type).toBe('fortified');
    expect(wine.grapes).toEqual(['g-1']);
  });

  test('a legacy snapshot without record fields leaves type/grapes alone (old ledger rows)', () => {
    const wine = fakeWine({ description: 'x', source: 'curator' });
    wine.type = 'white';
    wine.grapes = ['g-1'];
    restoreProfile(wine, { description: 'y', source: 'ai' }); // pre-feature prev
    expect(wine.type).toBe('white');
    expect(wine.grapes).toEqual(['g-1']);
  });
});
