jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), exists: jest.fn(), updateOne: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const { keyFor, run } = require('./rekey-star-grade-wines');
const { normalizeString, normalizeWineName } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const NAME = 'Zeltinger Sonnenuhr Riesling Auslese** Goldkapsel';
const OLD = 'markus molitor:zeltinger sonnenuhr riesling auslese goldkapsel:mosel';
const NEW = 'markus molitor:zeltinger sonnenuhr riesling auslese 2star goldkapsel:mosel';

describe('rekey-star-grade-wines keyFor', () => {
  const wine = (extra) => ({ name: NAME, producer: 'Markus Molitor', appellation: 'Mosel', ...extra });

  it('builds the star-stripped key the registry stored before, and the graded key now', () => {
    const w = wine({ normalizedKey: OLD });
    expect(keyFor(w, normalizeString)).toBe(OLD);
    expect(keyFor(w, normalizeWineName)).toBe(NEW);
  });

  it('keeps the pending and draft namespaces', () => {
    const pending = wine({ normalizedKey: 'pending~u1:zeltinger sonnenuhr riesling auslese goldkapsel:mosel' });
    expect(keyFor(pending, normalizeWineName)).toBe('pending~u1:zeltinger sonnenuhr riesling auslese 2star goldkapsel:mosel');
    const draft = wine({ normalizedKey: 'draft~u1:markus molitor:zeltinger sonnenuhr riesling auslese goldkapsel:mosel' });
    expect(keyFor(draft, normalizeWineName)).toBe('draft~u1:markus molitor:zeltinger sonnenuhr riesling auslese 2star goldkapsel:mosel');
  });
});

describe('rekey-star-grade-wines run', () => {
  const lean = (rows) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });
  const row = (id, extra) => ({ _id: id, name: NAME, producer: 'Markus Molitor', appellation: 'Mosel', normalizedKey: OLD, canonicalKey: 'stale', ...extra });

  beforeEach(() => {
    jest.clearAllMocks();
    WineDefinition.exists.mockResolvedValue(null);
    WineDefinition.updateOne.mockResolvedValue({});
  });

  it('queries with a pattern MongoDB accepts (a literal ★, never a \\u escape)', async () => {
    WineDefinition.find.mockReturnValue(lean([]));
    await run({ apply: false });
    const pattern = WineDefinition.find.mock.calls[0][0].name.$regex;
    expect(typeof pattern).toBe('string');
    expect(pattern).toContain('★');
    expect(pattern).not.toContain('\\u');
  });

  it('re-keys a star-stripped key and refreshes the canonical key', async () => {
    WineDefinition.find.mockReturnValue(lean([row('a')]));
    const r = await run({ apply: true });
    expect(r.rekeyed).toHaveLength(1);
    expect(WineDefinition.updateOne).toHaveBeenCalledWith({ _id: 'a' }, { $set: {
      normalizedKey: NEW, canonicalKey: computeCanonicalKey(NAME, 'Markus Molitor', 'Mosel'),
    } });
  });

  it('fixes a stale canonical key even when the dedup key is already current', async () => {
    WineDefinition.find.mockReturnValue(lean([row('a', { normalizedKey: NEW })]));
    const r = await run({ apply: true });
    expect(r.rekeyed).toHaveLength(0);
    expect(r.canonical).toHaveLength(1);
    expect(WineDefinition.updateOne).toHaveBeenCalledWith({ _id: 'a' }, { $set: { canonicalKey: computeCanonicalKey(NAME, 'Markus Molitor', 'Mosel') } });
  });

  it('never moves a key it did not build, nor onto a taken key — also within one run', async () => {
    WineDefinition.find.mockReturnValue(lean([
      row('odd', { normalizedKey: 'something:else:', canonicalKey: computeCanonicalKey(NAME, 'Markus Molitor', 'Mosel') }),
      row('a', { canonicalKey: computeCanonicalKey(NAME, 'Markus Molitor', 'Mosel') }),
      row('b', { canonicalKey: computeCanonicalKey(NAME, 'Markus Molitor', 'Mosel') }),
    ]));
    const r = await run({ apply: true });
    expect(r.rekeyed).toHaveLength(1);
    expect(r.skipped).toHaveLength(2);
    expect(WineDefinition.updateOne).toHaveBeenCalledTimes(1);
  });

  it('writes nothing in a dry run, and reports a failing row without stopping', async () => {
    WineDefinition.find.mockReturnValue(lean([row('a'), row('b', { name: NAME.replace('**', '***'), normalizedKey: OLD })]));
    WineDefinition.exists.mockRejectedValueOnce(new Error('boom'));
    const r = await run({ apply: false });
    expect(r.failed).toHaveLength(1);
    expect(r.rekeyed).toHaveLength(1);
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });

  it('is idempotent: current keys mean no write', async () => {
    WineDefinition.find.mockReturnValue(lean([row('a', { normalizedKey: NEW, canonicalKey: computeCanonicalKey(NAME, 'Markus Molitor', 'Mosel') })]));
    const r = await run({ apply: true });
    expect(r.rekeyed.length + r.canonical.length + r.skipped.length).toBe(0);
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });
});
