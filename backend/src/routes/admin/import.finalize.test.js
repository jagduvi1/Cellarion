/**
 * finalizeMintedWines — the post-import invariant repair (strategy 2026-07-29,
 * R4). The LWIN import's bulkWrite bypasses every mongoose hook, so rows it
 * inserts are born without canonicalKey (invisible to duplicate prevention),
 * slug (no public wine page) and createdVia (unreviewable as a class). This
 * pins: only the given ids are touched, each gains all three invariants, slug
 * collisions get the -2 suffix, existing values are never overwritten, and a
 * per-row failure doesn't abort the rest.
 */

jest.mock('../../services/search', () => ({ fullSync: jest.fn(), indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/Country', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Region', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Appellation', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));

const WineDefinition = require('../../models/WineDefinition');
const { finalizeMintedWines } = require('./import');
const { computeCanonicalKey } = require('../../utils/wineIdentity');

const doc = (over = {}) => ({
  _id: 'w1',
  name: 'Albe',
  producer: 'G.D. Vajra',
  appellation: 'Barolo',
  canonicalKey: null,
  slug: null,
  createdVia: null,
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

const selectChain = (result) => ({ select: jest.fn().mockReturnValue(
  typeof result?.then === 'function' ? result : Promise.resolve(result)
) });
const slugProbe = (result) => ({ select: () => ({ lean: () => Promise.resolve(result) }) });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.findOne.mockReturnValue(slugProbe(null)); // no slug collision
});

describe('finalizeMintedWines', () => {
  test('stamps canonicalKey, slug and createdVia on a bare imported row', async () => {
    const d = doc();
    WineDefinition.findById.mockReturnValue(selectChain(d));
    const n = await finalizeMintedWines(['w1']);
    expect(n).toBe(1);
    expect(d.canonicalKey).toBe(computeCanonicalKey('Albe', 'G.D. Vajra', 'Barolo'));
    expect(d.createdVia).toBe('import');
    expect(typeof d.slug).toBe('string');
    expect(d.slug.length).toBeGreaterThan(0);
    expect(d.save).toHaveBeenCalled();
  });

  test('slug collision gets the -2 suffix, mirroring the model pre-save hook', async () => {
    const d = doc();
    WineDefinition.findById.mockReturnValue(selectChain(d));
    // First probe: taken; second: free.
    WineDefinition.findOne
      .mockReturnValueOnce(slugProbe({ _id: 'other' }))
      .mockReturnValue(slugProbe(null));
    await finalizeMintedWines(['w1']);
    expect(d.slug.endsWith('-2')).toBe(true);
  });

  test('existing slug and createdVia are never overwritten', async () => {
    const d = doc({ slug: 'kept-slug', createdVia: 'ui' });
    WineDefinition.findById.mockReturnValue(selectChain(d));
    await finalizeMintedWines(['w1']);
    expect(d.slug).toBe('kept-slug');
    expect(d.createdVia).toBe('ui');
    // canonicalKey is always recomputed — idempotent by construction.
    expect(d.canonicalKey).toBe(computeCanonicalKey('Albe', 'G.D. Vajra', 'Barolo'));
  });

  test('a per-row failure is non-fatal — the rest still finalize', async () => {
    const bad = doc({ _id: 'w1', save: jest.fn().mockRejectedValue(new Error('boom')) });
    const good = doc({ _id: 'w2' });
    WineDefinition.findById
      .mockReturnValueOnce(selectChain(bad))
      .mockReturnValueOnce(selectChain(good));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const n = await finalizeMintedWines(['w1', 'w2']);
    expect(n).toBe(1);
    expect(good.save).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a vanished id is skipped without counting', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(null));
    expect(await finalizeMintedWines(['gone'])).toBe(0);
  });
});
