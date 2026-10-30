/**
 * Classification through the pending-wine fix (fix_pending_wine over MCP) —
 * added with #1701 (audit 2026-10-26): the admin form gained the field, and
 * MCP parity means the sommelier completing a pending wine can set or clear
 * the tier too. The mint's rule applies: a regulatory mark stores as none.
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
jest.mock('./findOrCreateWine', () => ({ findOrCreateRegion: jest.fn().mockResolvedValue({ _id: 'region-1' }) }));
jest.mock('./appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('./wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20,
  GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));

const { validatePendingFix, applyPendingFix, FIXABLE_FIELDS } = require('./pendingWineOps');

const CREATOR = '507f1f77bcf86cd799439011';
const CURATOR = '507f1f77bcf86cd799439022';

/** A pending row that behaves like a mongoose doc for save() and assignment. */
const pendingWine = (over = {}) => {
  const wine = {
    _id: 'wine-1',
    name: 'Barolo',
    producer: '',
    appellation: 'Barolo',
    classification: null,
    type: 'red',
    country: 'country-1',
    region: null,
    grapes: [],
    createdBy: CREATOR,
    pendingIdentity: true,
    normalizedKey: `pending~${CREATOR}:barolo:`,
    slug: undefined,
    ...over,
  };
  wine.save = jest.fn(async () => wine);
  return wine;
};

describe('validatePendingFix — classification', () => {
  test('is a fixable field; whitespace folds; "" clears', () => {
    expect(FIXABLE_FIELDS).toContain('classification');
    expect(validatePendingFix({ classification: '  Riserva ' })).toEqual({ ok: true, clean: { classification: 'Riserva' } });
    expect(validatePendingFix({ classification: '' })).toEqual({ ok: true, clean: { classification: '' } });
  });

  test('refuses a non-string', () => {
    const r = validatePendingFix({ classification: 7 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/classification must be a string/);
  });
});

describe('applyPendingFix — classification', () => {
  test('stores a tier on a row that stays pending', async () => {
    const wine = pendingWine();
    const res = await applyPendingFix(wine, { classification: 'Riserva' }, CURATOR);
    expect(res.ok).toBe(true);
    expect(wine.classification).toBe('Riserva');
    expect(wine.save).toHaveBeenCalled();
  });

  test('a regulatory mark stores as none; "" clears a stored tier', async () => {
    const marked = pendingWine();
    expect((await applyPendingFix(marked, { classification: 'DOCG' }, CURATOR)).ok).toBe(true);
    expect(marked.classification).toBeNull();

    const cleared = pendingWine({ classification: 'Riserva' });
    expect((await applyPendingFix(cleared, { classification: '' }, CURATOR)).ok).toBe(true);
    expect(cleared.classification).toBeNull();
  });

  test('an untouched classification survives another fix', async () => {
    const wine = pendingWine({ classification: 'Riserva' });
    await applyPendingFix(wine, { appellation: 'Barolo' }, CURATOR);
    expect(wine.classification).toBe('Riserva');
  });
});

describe('applyPendingFix — classification against the taxonomy (strict for a curator)', () => {
  const ops = require('./classificationOps');
  beforeEach(() => ops.primeClassificationCache([
    { _id: 'r1', name: 'Riserva', kind: 'ageing', country: null, synonyms: [] },
    { _id: 'r2', name: 'Gran Selezione', kind: 'ageing', country: null, synonyms: [] },
  ]));
  afterEach(() => ops.primeClassificationCache(null));

  test('a known tier stores its rows and the canonical string', async () => {
    const wine = pendingWine();
    const res = await applyPendingFix(wine, { classification: 'riserva DOCG' }, CURATOR);
    expect(res.ok).toBe(true);
    expect(wine.classification).toBe('Riserva');
    expect(wine.classifications).toEqual(['r1']);
  });

  test('a word the taxonomy lacks is refused with the known tiers, and nothing is saved', async () => {
    const wine = pendingWine();
    const res = await applyPendingFix(wine, { classification: 'Grand Vin de Bordeaux' }, CURATOR);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('invalid_input');
    expect(res.message).toMatch(/"Grand Vin de Bordeaux" is not in the registry/);
    expect(res.message).toMatch(/Riserva/);
    expect(wine.save).not.toHaveBeenCalled();
  });
});
