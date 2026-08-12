/**
 * "No producer on the label" — the REVERSIBLE queue disposition.
 *
 * Some bottles genuinely print no producer: retailer own-labels, négociant
 * clean-skins, unlabelled bin-ends. Two are in the prod queue now. A curator has
 * to be able to clear them from a list of WORK — but must never be able to
 * PROMOTE them: producer is 45% of the composite duplicate score, so a
 * producerless row in the shared registry would attract every other
 * producerless wine to itself.
 *
 * So the contract pinned here is: the row leaves the QUEUE and nothing else
 * changes. pendingIdentity stays true, every exclusion it carries stays in
 * force, and one boolean puts it back.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), updateOne: jest.fn() }));
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
jest.mock('./findOrCreateWine', () => ({ findOrCreateRegion: jest.fn() }));
jest.mock('./wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20, GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));

const WineDefinition = require('../models/WineDefinition');
const searchService = require('./search');
const { reembedActiveVintages } = require('./embeddingJob');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
const {
  validatePendingFix, applyPendingFix, queryPendingWines, FIXABLE_FIELDS,
} = require('./pendingWineOps');

const CREATOR = '507f1f77bcf86cd799439011';
const CURATOR = '507f1f77bcf86cd799439022';

const pendingWine = (over = {}) => {
  const wine = {
    _id: 'wine-1',
    name: 'Rich Ruby Red',
    producer: '',
    appellation: null,
    type: 'red',
    country: 'country-1',
    createdBy: CREATOR,
    pendingIdentity: true,
    identityUnavailable: false,
    normalizedKey: `pending~${CREATOR}:rich ruby red:`,
    ...over,
  };
  wine.save = jest.fn(async () => {
    // The real hook: promotion also clears the disposition.
    const { isIdentitySentinel, isImplausibleIdentity } = require('../utils/normalize');
    if (wine.pendingIdentity === true &&
        !isIdentitySentinel(wine.producer) && !isIdentitySentinel(wine.name) &&
        !isImplausibleIdentity(wine.producer, wine.name)) {
      wine.pendingIdentity = false;
      wine.identityUnavailable = false;
    }
    return wine;
  });
  return wine;
};

beforeEach(() => jest.clearAllMocks());

describe('validation', () => {
  test('it is a fixable field', () => {
    expect(FIXABLE_FIELDS).toContain('identityUnavailable');
  });

  test('true and FALSE both pass — false is the undo and must survive the loop', () => {
    expect(validatePendingFix({ identityUnavailable: true })).toEqual({ ok: true, clean: { identityUnavailable: true } });
    expect(validatePendingFix({ identityUnavailable: false })).toEqual({ ok: true, clean: { identityUnavailable: false } });
  });

  test('anything non-boolean is refused', () => {
    for (const v of ['true', 1, null, {}]) {
      expect(validatePendingFix({ identityUnavailable: v }).ok).toBe(false);
    }
  });
});

describe('applying it', () => {
  test('the row is dispositioned WITHOUT being promoted', async () => {
    const wine = pendingWine();
    const res = await applyPendingFix(wine, { identityUnavailable: true }, CURATOR);

    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(false);
    expect(wine.identityUnavailable).toBe(true);
    // THE POINT: it is still pending, so every exclusion it carries holds.
    expect(wine.pendingIdentity).toBe(true);
    expect(wine.producer).toBe('');
  });

  test('none of the promotion follow-through runs — it is not in the registry', async () => {
    await applyPendingFix(pendingWine(), { identityUnavailable: true }, CURATOR);

    expect(searchService.indexWine).not.toHaveBeenCalled();
    expect(reembedActiveVintages).not.toHaveBeenCalled();
    expect(ensurePendingVintageProfile).not.toHaveBeenCalled();
  });

  test('it keeps its per-creator pending key — the namespace invariant is untouched', async () => {
    const wine = pendingWine();
    await applyPendingFix(wine, { identityUnavailable: true }, CURATOR);
    expect(wine.normalizedKey).toContain('pending~');
  });

  test('REVERSIBLE — false puts it back', async () => {
    const wine = pendingWine({ identityUnavailable: true });
    const res = await applyPendingFix(wine, { identityUnavailable: false }, CURATOR);

    expect(res.ok).toBe(true);
    expect(wine.identityUnavailable).toBe(false);
    expect(wine.pendingIdentity).toBe(true);
  });

  test('the change is in the diff, so the audit entry records it', async () => {
    const res = await applyPendingFix(pendingWine(), { identityUnavailable: true }, CURATOR);
    expect(res.diff.identityUnavailable).toEqual({ from: false, to: true });
  });

  test('a producer arriving later PROMOTES and clears the disposition', async () => {
    // A wine WITH a producer cannot be one whose producer is unavailable.
    const wine = pendingWine({ identityUnavailable: true });
    const res = await applyPendingFix(wine, { producer: 'Aldi' }, CURATOR);

    expect(res.promoted).toBe(true);
    expect(wine.identityUnavailable).toBe(false);
  });
});

describe('the queue listing', () => {
  const primeCounts = () => {
    const chain = {};
    for (const m of ['sort', 'skip', 'limit', 'populate']) chain[m] = jest.fn(() => chain);
    chain.lean = jest.fn().mockResolvedValue([]);
    WineDefinition.find.mockReturnValue(chain);
    WineDefinition.countDocuments.mockResolvedValue(0);
    require('../models/Bottle').find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  };

  test('dispositioned rows are EXCLUDED by default — this queue is a list of work', async () => {
    primeCounts();
    await queryPendingWines({});
    expect(WineDefinition.find.mock.calls[0][0]).toEqual({
      pendingIdentity: true, identityUnavailable: { $ne: true },
    });
  });

  test('…and one flag shows them again, so the record can be reversed', async () => {
    primeCounts();
    await queryPendingWines({ includeUnavailable: true });
    expect(WineDefinition.find.mock.calls[0][0]).toEqual({ pendingIdentity: true });
  });

  test('the work figure excludes them and they are counted separately', async () => {
    primeCounts();
    await queryPendingWines({});
    const counted = WineDefinition.countDocuments.mock.calls.map(c => c[0]);
    expect(counted).toContainEqual({ pendingIdentity: true, identityUnavailable: { $ne: true } });
    expect(counted).toContainEqual({ pendingIdentity: true, identityUnavailable: true });
  });
});
