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
jest.mock('../../models/WineDefinition', () => ({
  findById: jest.fn(), findOne: jest.fn(), findFreeSlug: jest.fn(),
}));
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
  // The real static (models/WineDefinition) probes slug AND previousSlugs; here
  // the base is simply free.
  WineDefinition.findFreeSlug.mockImplementation(async (base) => base);
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

  test('the slug comes from findFreeSlug — NOT a bare { slug } probe (audit M-5)', async () => {
    // This was the fifth slug-assignment site and the only one still blind to
    // previousSlugs: a bare `findOne({ slug })` happily hands an import a slug
    // that another wine still ANSWERS TO after a rename, and then
    // { $or: [{slug}, {previousSlugs}] } matches two documents and /wines/<slug>
    // resolves nondeterministically. Suffix behaviour itself is pinned on the
    // static (models/WineDefinition.slugRename.test.js).
    const d = doc();
    WineDefinition.findById.mockReturnValue(selectChain(d));
    WineDefinition.findFreeSlug.mockResolvedValue('albe-2');

    await finalizeMintedWines(['w1']);

    expect(WineDefinition.findFreeSlug).toHaveBeenCalledTimes(1);
    expect(d.slug).toBe('albe-2');
    // No hand-rolled probe survives anywhere on this path.
    expect(WineDefinition.findOne).not.toHaveBeenCalled();
  });

  test('a save collision re-asks findFreeSlug instead of mangling the slug', async () => {
    const err = Object.assign(new Error('dup'), { code: 11000 });
    const d = doc({ save: jest.fn().mockRejectedValueOnce(err).mockResolvedValue(undefined) });
    WineDefinition.findById.mockReturnValue(selectChain(d));
    WineDefinition.findFreeSlug
      .mockResolvedValueOnce('albe')
      .mockResolvedValueOnce('albe-2');

    expect(await finalizeMintedWines(['w1'])).toBe(1);
    // Was `${doc.slug}-r1` — a slug nothing had checked against previousSlugs.
    expect(d.slug).toBe('albe-2');
  });

  test('a save collision that is NOT the slug is not retried forever', async () => {
    // findFreeSlug returning the same value means the 11000 came from
    // normalizedKey; mangling the URL would not fix it, so the row fails
    // (non-fatally) instead of spinning.
    const err = Object.assign(new Error('dup'), { code: 11000 });
    const d = doc({ save: jest.fn().mockRejectedValue(err) });
    WineDefinition.findById.mockReturnValue(selectChain(d));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await finalizeMintedWines(['w1'])).toBe(0);
    expect(d.save).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
