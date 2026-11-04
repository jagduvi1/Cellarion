/**
 * The standard wine-record fields a new install starts with (ABV, Closure).
 *
 * WHY THIS TEST EXISTS:
 * A fresh self-hosted server had no ABV field anywhere: the wine record showed
 * no ABV row until its admin proposed the field and accepted it, so a member
 * could not find where to put the alcohol percentage (discussion #1778). The
 * seed must give a new registry cellarion.app's own definitions — the Registry
 * Bridge finds a field by name, and a different type or unit would clash — and
 * must never touch a registry that already has fields (no duplicate beside a
 * field of the same meaning, no field the admin rejected coming back).
 */
jest.mock('../models/RegistryDataKey', () => {
  const Actual = jest.requireActual('../models/RegistryDataKey');
  Actual.estimatedDocumentCount = jest.fn();
  Actual.create = jest.fn();
  return Actual;
});
jest.mock('./registryDataOps', () => ({ invalidateVocabCache: jest.fn() }));

const RegistryDataKey = require('../models/RegistryDataKey');
const { invalidateVocabCache } = require('./registryDataOps');
const { ensureStandardKeys, STANDARD_KEYS } = require('./registryKeySeed');

beforeEach(() => jest.clearAllMocks());

test('a registry with no fields gets ABV and Closure, accepted, as cellarion.app defines them', async () => {
  RegistryDataKey.estimatedDocumentCount.mockResolvedValue(0);
  RegistryDataKey.create.mockResolvedValue({});
  const now = new Date('2026-11-04T12:00:00Z');

  expect(await ensureStandardKeys(now)).toEqual({ seeded: true, created: 2 });

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

test('a registry that has any field keeps exactly what its admin chose', async () => {
  RegistryDataKey.estimatedDocumentCount.mockResolvedValue(3);
  expect(await ensureStandardKeys()).toEqual({ seeded: false, created: 0 });
  expect(RegistryDataKey.create).not.toHaveBeenCalled();
  expect(invalidateVocabCache).not.toHaveBeenCalled();
});

test('a field another process created first is no error', async () => {
  RegistryDataKey.estimatedDocumentCount.mockResolvedValue(0);
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
