/**
 * The two identity gates on the CURATION WRITE PATH
 * (services/pendingWineOps.applyPendingFix).
 *
 *   SHAPE       — the same DB-free predicate the model's auto-promote hook
 *                 uses. The hook can only decline to promote, silently; here
 *                 the curator is TOLD, because a fix that "succeeded" and left
 *                 the row in the queue with no reason is how the
 *                 "Increíble"/"Increíble" class gets retried instead of
 *                 corrected.
 *   CROSS-FIELD — the taxonomy-dependent half, which the hook cannot run (a
 *                 pre-validate hook must not do I/O): a producer that is
 *                 actually a region, appellation, country, grape, style term or
 *                 placeholder. Existing rules from utils/crossFieldChecks,
 *                 restricted to the producer-is-not-a-producer family.
 *
 * Both must REFUSE rather than write, and neither may block a legitimate fix.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('./crossFieldScan', () => ({ detectCrossFieldForValues: jest.fn().mockResolvedValue(null) }));
jest.mock('./search', () => ({
  indexWine: jest.fn().mockResolvedValue(undefined),
  bulkIndexBottles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateRegion: jest.fn().mockResolvedValue({ _id: 'region-1' }) }));
jest.mock('./wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20,
  GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));

const { detectCrossFieldForValues } = require('./crossFieldScan');
const { applyPendingFix } = require('./pendingWineOps');
const { IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS, CROSS_FIELD_CHECK_IDS } = require('../utils/crossFieldChecks');

const CREATOR = '507f1f77bcf86cd799439011';
const CURATOR = '507f1f77bcf86cd799439022';

/**
 * A pending row that behaves like a mongoose doc for the two things this path
 * uses: save() (which runs the promotion hook) and field assignment.
 */
const pendingWine = (over = {}) => {
  const wine = {
    _id: 'wine-1',
    name: 'Increíble',
    producer: '',
    appellation: null,
    type: 'red',
    country: 'country-1',
    region: null,
    grapes: [],
    createdBy: CREATOR,
    pendingIdentity: true,
    normalizedKey: `pending~${CREATOR}:increible:`,
    slug: undefined,
    ...over,
  };
  // The real hook's rule, so a test that gets past the gates promotes exactly
  // as production would.
  wine.save = jest.fn(async () => {
    const { isIdentitySentinel, isImplausibleIdentity } = require('../utils/normalize');
    if (wine.pendingIdentity === true &&
        !isIdentitySentinel(wine.producer) && !isIdentitySentinel(wine.name) &&
        !isImplausibleIdentity(wine.producer, wine.name)) {
      wine.pendingIdentity = false;
    }
    return wine;
  });
  return wine;
};

beforeEach(() => {
  jest.clearAllMocks();
  detectCrossFieldForValues.mockResolvedValue(null);
});

describe('shape gate', () => {
  test('INVERTED: completing "Increíble" with producer "Increíble" is ACCEPTED and promotes', async () => {
    // Was refused. Refusing it also refused a curator writing "Petrus" as the
    // producer of "Petrus" — the single-wine estate, 67 of 91 sampled real
    // pairs (audit H-1/H-2). The suspicion is now producer-echoes-name.v1 in
    // the cross-field REVIEW queue, where a curator with the label photo (still
    // readable for 7 days after promotion) can clear it or correct it.
    const wine = pendingWine();
    const res = await applyPendingFix(wine, { producer: 'Increíble' }, CURATOR);

    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);
    expect(wine.producer).toBe('Increíble');
  });

  test('what the shape gate STILL refuses: a producer that is only house words', async () => {
    const wine = pendingWine();
    const res = await applyPendingFix(wine, { producer: 'Domaine' }, CURATOR);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('invalid_input');
    expect(res.message).toMatch(/not a usable producer/i);
    expect(wine.save).not.toHaveBeenCalled();
    expect(wine.pendingIdentity).toBe(true);
  });

  test('it runs BEFORE any DB work — no taxonomy round-trip is spent on a doomed fix', async () => {
    await applyPendingFix(pendingWine(), { producer: 'Domaine' }, CURATOR);
    expect(detectCrossFieldForValues).not.toHaveBeenCalled();
  });

  test('a legitimate completion still promotes', async () => {
    const wine = pendingWine({ name: 'Sauvignon Blanc' });
    const res = await applyPendingFix(wine, { producer: 'Cloudy Bay' }, CURATOR);

    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);
    expect(wine.producer).toBe('Cloudy Bay');
    // Promotion moves the row out of the per-creator pending key namespace.
    expect(wine.normalizedKey).not.toContain('pending~');
  });

  test('an appellation-only touch-up of a row STAYING pending is not gated', async () => {
    const wine = pendingWine();
    const res = await applyPendingFix(wine, { appellation: 'Rioja' }, CURATOR);

    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(false);
    expect(detectCrossFieldForValues).not.toHaveBeenCalled();
    // …and it keeps its per-creator key (audit M-2 stays fixed).
    expect(wine.normalizedKey).toContain('pending~');
  });
});

describe('cross-field gate', () => {
  test('a producer that is a REGION is refused, naming the rule', async () => {
    detectCrossFieldForValues.mockResolvedValue([{ check: 'producer-is-region.v1', detail: 'Tokaj' }]);
    const wine = pendingWine({ name: 'Aszú 5 Puttonyos' });

    const res = await applyPendingFix(wine, { producer: 'Tokaji' }, CURATOR);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('invalid_input');
    expect(res.message).toContain('producer-is-region.v1');
    expect(res.message).toContain('Tokaj');
    expect(wine.save).not.toHaveBeenCalled();
  });

  test('it runs the EXISTING rule set, restricted to the producer family', async () => {
    await applyPendingFix(pendingWine({ name: 'Aszú' }), { producer: 'Tokaji' }, CURATOR);

    const [values, checkIds] = detectCrossFieldForValues.mock.calls[0];
    expect(values).toMatchObject({ producer: 'Tokaji', name: 'Aszú' });
    expect(checkIds).toBe(IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS);
    // Every enforced id must be a real rule — a version bump that forgot this
    // list would otherwise disable enforcement silently.
    for (const id of IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS) {
      expect(CROSS_FIELD_CHECK_IDS).toContain(id);
    }
  });

  test('the formatting rules are NOT enforced — they would trap correct transcriptions', () => {
    expect(IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS).not.toContain('name-in-producer.v1');
    expect(IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS).not.toContain('producer-parenthetical.v1');
    expect(IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS).not.toContain('appellation-is-grape.v1');
    expect(IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS).not.toContain('region-is-country.v1');
  });

  test('a clean producer passes and the row promotes', async () => {
    const wine = pendingWine({ name: 'Aszú 5 Puttonyos' });
    const res = await applyPendingFix(wine, { producer: 'Disznókő' }, CURATOR);

    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);
    expect(detectCrossFieldForValues).toHaveBeenCalledTimes(1);
  });
});

/**
 * The OVERRIDE (audit L-10b). Users can mint Regions and Appellations, so a
 * junk taxonomy row bearing a real producer's name made that producer
 * permanently unwritable — and the only escape left was identityUnavailable,
 * i.e. recording a FALSEHOOD about a label that plainly prints the name.
 */
describe('cross-field override', () => {
  const REGION_HIT = [{ check: 'producer-is-region.v1', detail: 'Ferreirinha' }];

  test('the refusal names the override instead of leaving the curator stuck', async () => {
    detectCrossFieldForValues.mockResolvedValue(REGION_HIT);
    const res = await applyPendingFix(pendingWine({ name: 'Barca Velha' }), { producer: 'Ferreirinha' }, CURATOR);

    expect(res.ok).toBe(false);
    expect(res.message).toContain('crossFieldOverride: true');
  });

  test('with the override the write lands, and the overridden rules come back for the audit log', async () => {
    detectCrossFieldForValues.mockResolvedValue(REGION_HIT);
    const wine = pendingWine({ name: 'Barca Velha' });

    const res = await applyPendingFix(wine, { producer: 'Ferreirinha', crossFieldOverride: true }, CURATOR);

    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);
    expect(res.crossFieldOverridden).toEqual([{ check: 'producer-is-region.v1', detail: 'Ferreirinha' }]);
  });

  test('a clean write reports NO override — the audit entry must not claim one', async () => {
    const res = await applyPendingFix(pendingWine({ name: 'Barca Velha' }), { producer: 'Ferreirinha', crossFieldOverride: true }, CURATOR);
    expect(res.ok).toBe(true);
    expect(res.crossFieldOverridden).toBeNull();
  });

  test('it does not disarm the SHAPE gate — that one has no override', async () => {
    // The shape gate refuses only what cannot be an identity in any language;
    // there is no taxonomy mistake for a curator to be right about.
    const res = await applyPendingFix(pendingWine(), { producer: 'Domaine', crossFieldOverride: true }, CURATOR);
    expect(res.ok).toBe(false);
  });
});
