/**
 * The standard wine-record fields every install has (ABV, Closure).
 *
 * WHY THIS TEST EXISTS:
 * A fresh self-hosted server had no ABV field anywhere: the wine record showed
 * no ABV row until its admin proposed the field and accepted it, so a member
 * could not find where to put the alcohol percentage (discussion #1778). The
 * seed must give a registry cellarion.app's own definitions — the Registry
 * Bridge finds a field by name, and a different type or unit would clash — for
 * every standard field it LACKS, also on a registry that already has fields of
 * its own (the first version seeded only an empty registry, so an admin who had
 * proposed one field before the release never got the standard ones). It must
 * never touch a name the registry knows: no second field beside one of the
 * same name, and no field the admin rejected coming back.
 */
jest.mock('../models/RegistryDataKey', () => {
  const Actual = jest.requireActual('../models/RegistryDataKey');
  Actual.exists = jest.fn();
  Actual.create = jest.fn();
  return Actual;
});
jest.mock('./registryDataOps', () => ({ invalidateVocabCache: jest.fn() }));

const RegistryDataKey = require('../models/RegistryDataKey');
const { invalidateVocabCache } = require('./registryDataOps');
const { ensureStandardKeys, STANDARD_KEYS } = require('./registryKeySeed');

beforeEach(() => jest.clearAllMocks());

test('a registry with no fields gets ABV and Closure, accepted, as cellarion.app defines them', async () => {
  RegistryDataKey.exists.mockResolvedValue(null);
  RegistryDataKey.create.mockResolvedValue({});
  const now = new Date('2026-11-04T12:00:00Z');

  expect(await ensureStandardKeys(now)).toEqual({ seeded: true, created: 2 });

  // Looked up by the lowercased nameKey, the column the uniqueness index is on.
  expect(RegistryDataKey.exists.mock.calls.map((c) => c[0])).toEqual([{ nameKey: 'abv' }, { nameKey: 'closure' }]);
  const rows = RegistryDataKey.create.mock.calls.map((c) => c[0]);
  expect(rows).toEqual([
    expect.objectContaining({
      name: 'ABV', type: 'decimal', unit: '%', status: 'accepted', proposedBy: null, decidedAt: now,
      translations: { de: 'Alkoholgehalt', fr: "Degré d'alcool", sv: 'Alkoholhalt' },
    }),
    expect.objectContaining({
      name: 'Closure', type: 'enum', status: 'accepted', proposedBy: null,
      enumOptions: ['Cork', 'Technical cork', 'Synthetic cork', 'Screw cap', 'Glass stopper', 'Crown cap'],
    }),
  ]);
  expect(invalidateVocabCache).toHaveBeenCalledTimes(1);
});

test('a registry that already has a field of that name keeps it, and still gets the standard field it lacks', async () => {
  // The admin's own "ABV" — accepted as text, say — is their decision; only
  // Closure is missing. exists() answers for any status (a rejected row too).
  RegistryDataKey.exists.mockImplementation(async ({ nameKey }) => (nameKey === 'abv' ? { _id: 'x' } : null));
  RegistryDataKey.create.mockResolvedValue({});

  expect(await ensureStandardKeys()).toEqual({ seeded: true, created: 1 });

  expect(RegistryDataKey.create).toHaveBeenCalledTimes(1);
  expect(RegistryDataKey.create.mock.calls[0][0]).toEqual(expect.objectContaining({ name: 'Closure' }));
  expect(invalidateVocabCache).toHaveBeenCalledTimes(1);
});

test('a registry that has every standard field is left untouched', async () => {
  RegistryDataKey.exists.mockResolvedValue({ _id: 'x' });
  expect(await ensureStandardKeys()).toEqual({ seeded: false, created: 0 });
  expect(RegistryDataKey.create).not.toHaveBeenCalled();
  expect(invalidateVocabCache).not.toHaveBeenCalled();
});

test('a field another process created first is no error', async () => {
  RegistryDataKey.exists.mockResolvedValue(null);
  RegistryDataKey.create
    .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
    .mockResolvedValueOnce({});
  expect(await ensureStandardKeys()).toEqual({ seeded: true, created: 1 });
  RegistryDataKey.create.mockRejectedValueOnce(new Error('disk full'));
  await expect(ensureStandardKeys()).rejects.toThrow('disk full');
});

test('every standard field passes the model; only a proposal needs a proposer', async () => {
  // validate() runs the model's pre-validate hooks (nameKey), as a save does.
  for (const def of STANDARD_KEYS) {
    const doc = new RegistryDataKey({ ...def, rationale: 'A standard field: every Cellarion install starts with it.', status: 'accepted', proposedBy: null });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.nameKey).toBe(def.name.toLowerCase());
  }
  const proposal = new RegistryDataKey({ name: 'Vineyard area', type: 'decimal', rationale: 'Hectares under vine.', status: 'proposed' });
  const err = await proposal.validate().then(() => null, (e) => e);
  expect(err?.errors?.proposedBy?.message).toBe('A proposal needs its proposer');
});
