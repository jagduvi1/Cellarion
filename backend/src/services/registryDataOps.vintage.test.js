/**
 * Per-vintage overrides on public values (2026-09-04).
 *
 * `vintage: null` is the wine-wide default, 'YYYY' an override for that
 * bottling. A figure off a label or a one-year retailer page belongs in the
 * vintage slot; readers resolve override → default → blank. Same mock rig as
 * registryDataOps.test.js.
 */

jest.mock('../models/RegistryDataKey', () => ({
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(),
  countDocuments: jest.fn(), findOneAndUpdate: jest.fn(),
}));
jest.mock('../models/RegistryDataValue', () => ({
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(),
  countDocuments: jest.fn(), deleteOne: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('./contributionGate', () => ({
  TIER_DAILY: { newcomer: 3, contributor: 5, enthusiast: 10, connoisseur: 20, ambassador: 30 },
  checkContributionGate: jest.fn(),
}));
jest.mock('./wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn(() => Promise.resolve()) }));

const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const { checkContributionGate } = require('./contributionGate');
const { findVisibleWine } = require('./wineVisibility');
const { createNotification } = require('./notifications');
const { logAudit } = require('./audit');
const ops = require('./registryDataOps');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');
const KEY = oid('c');
const ADMIN = oid('d');

const acceptedKey = { _id: KEY, name: 'ABV', nameKey: 'abv', type: 'decimal', unit: '%', status: 'accepted' };

const chain = (result) => {
  const c = {};
  for (const m of ['sort', 'populate', 'select', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};

const GOOD = { wineId: WINE, keyId: KEY, value: 13.5 };
const dflt = { _id: oid('1'), key: KEY, value: 13.5, suggestedBy: { username: 'kurt' } };
const ovr23 = { _id: oid('2'), key: KEY, vintage: '2023', value: 14, suggestedBy: { username: 'akki' } };

beforeEach(() => {
  jest.clearAllMocks();
  ops.invalidateVocabCache();
  checkContributionGate.mockResolvedValue({ ok: true, user: { contribution: { tier: 'newcomer' } } });
  findVisibleWine.mockResolvedValue({ _id: WINE, producer: 'Cloudy Bay', name: 'Sauvignon Blanc' });
});

describe('the slot helpers', () => {
  test('normaliseVintage: blank/all/NV/Unknown → the default slot; a year is canonical; junk is refused', () => {
    for (const v of [undefined, null, '', 'all', 'NV', 'nv', 'Unknown']) {
      expect(ops.normaliseVintage(v)).toEqual({ ok: true, value: null });
    }
    expect(ops.normaliseVintage(' 2023 ')).toEqual({ ok: true, value: '2023' });
    expect(ops.normaliseVintage(2019)).toEqual({ ok: true, value: '2019' });
    expect(ops.normaliseVintage('20x3').ok).toBe(false);
    expect(ops.normaliseVintage('1850').ok).toBe(false);
  });

  test('resolveForVintage: the exact year wins, else the default, else nothing', () => {
    const rows = [dflt, ovr23];
    expect(ops.resolveForVintage(rows, '2023')).toEqual({ row: ovr23, from: 'vintage' });
    expect(ops.resolveForVintage(rows, '2021')).toEqual({ row: dflt, from: 'wine' });
    expect(ops.resolveForVintage(rows, null)).toEqual({ row: dflt, from: 'wine' });
    expect(ops.resolveForVintage([ovr23], '2021')).toEqual({ row: null, from: null });
  });
});

describe('suggestValue with a vintage', () => {
  test('files into the vintage slot and checks both that slot and the default for no-ops', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne.mockResolvedValue(null);
    RegistryDataValue.create.mockResolvedValue({ _id: oid('9'), value: 14, status: 'suggested' });

    const res = await ops.suggestValue(ME, { ...GOOD, value: 14, vintage: '2023' });
    expect(res.ok).toBe(true);
    expect(res.value.vintage).toBe('2023');
    expect(RegistryDataValue.create).toHaveBeenCalledWith(expect.objectContaining({ vintage: '2023', value: 14 }));
    expect(RegistryDataValue.findOne).toHaveBeenNthCalledWith(1, expect.objectContaining({ vintage: '2023', status: 'published' }));
    expect(RegistryDataValue.findOne).toHaveBeenNthCalledWith(2, expect.objectContaining({ vintage: null, status: 'published' }));
    expect(logAudit).toHaveBeenCalledWith(null, 'registry_data.value_suggest', expect.anything(),
      expect.objectContaining({ vintage: '2023' }));
  });

  test('an override that only repeats the wine-wide default is a no-op conflict', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: 13.5, status: 'published' });
    const res = await ops.suggestValue(ME, { ...GOOD, vintage: '2023' });
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(res.message).toMatch(/2023 inherits it/);
    expect(RegistryDataValue.create).not.toHaveBeenCalled();
  });

  test('a malformed vintage is refused before any write; NV collapses to the default slot', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    expect((await ops.suggestValue(ME, { ...GOOD, vintage: '20x3' })).code).toBe('invalid');
    expect(RegistryDataValue.create).not.toHaveBeenCalled();

    RegistryDataValue.findOne.mockResolvedValue(null);
    RegistryDataValue.create.mockResolvedValue({ _id: oid('9'), value: 13.5, status: 'suggested' });
    const res = await ops.suggestValue(ME, { ...GOOD, vintage: 'NV' });
    expect(res.value.vintage).toBeNull();
    expect(RegistryDataValue.create).toHaveBeenCalledWith(expect.objectContaining({ vintage: null }));
  });

  test('the duplicate-slot message names the year', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne.mockResolvedValue(null);
    RegistryDataValue.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const res = await ops.suggestValue(ME, { ...GOOD, vintage: '2023' });
    expect(res.code).toBe('conflict');
    expect(res.message).toMatch(/A 2023 value/);
  });
});

describe('dataForWine with a vintage', () => {
  const twoLayers = () => RegistryDataValue.find
    .mockReturnValueOnce(chain([dflt, ovr23]))
    .mockReturnValueOnce(chain([]));

  test('resolves the asked vintage: override when published, else the default, both layers exposed', async () => {
    RegistryDataKey.find.mockReturnValue(chain([acceptedKey]));

    twoLayers();
    const for23 = await ops.dataForWine(WINE, ME, { vintage: '2023' });
    expect(for23.vintage).toBe('2023');
    expect(for23.fields[0]).toMatchObject({
      value: 14, resolvedFrom: 'vintage', resolvedVintage: '2023', contributedBy: 'akki',
      wineValue: 13.5, overrides: [{ vintage: '2023', value: 14 }],
    });

    twoLayers();
    const for21 = await ops.dataForWine(WINE, ME, { vintage: '2021' });
    expect(for21.fields[0]).toMatchObject({ value: 13.5, resolvedFrom: 'wine', resolvedVintage: null, contributedBy: 'kurt' });

    twoLayers();
    const plain = await ops.dataForWine(WINE, ME);
    expect(plain.vintage).toBeNull();
    expect(plain.fields[0]).toMatchObject({ value: 13.5, resolvedFrom: 'wine' });
  });

  test('a malformed asked vintage reads the default rather than failing the page', async () => {
    RegistryDataKey.find.mockReturnValue(chain([acceptedKey]));
    twoLayers();
    const res = await ops.dataForWine(WINE, ME, { vintage: 'Unknown' });
    expect(res.ok).toBe(true);
    expect(res.vintage).toBeNull();
    expect(res.fields[0]).toMatchObject({ value: 13.5, resolvedFrom: 'wine' });
  });

  test('pending flags are slot-aware: a 2023 suggestion does not block the wine-wide slot, and vice versa', async () => {
    RegistryDataKey.find.mockReturnValue(chain([acceptedKey]));
    const pending23 = { key: KEY, vintage: '2023', value: 14, status: 'suggested', suggestedBy: oid('9') };

    RegistryDataValue.find.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([pending23]));
    const plain = await ops.dataForWine(WINE, ME);
    expect(plain.fields[0]).toMatchObject({ hasPendingSuggestion: false, hasPendingWineSuggestion: false });

    RegistryDataValue.find.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([pending23]));
    const for23 = await ops.dataForWine(WINE, ME, { vintage: '2023' });
    expect(for23.fields[0]).toMatchObject({ hasPendingSuggestion: true });

    RegistryDataValue.find.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([{ ...pending23, suggestedBy: ME }]));
    const mine = await ops.dataForWine(WINE, ME, { vintage: '2023' });
    expect(mine.fields[0].mySuggestion).toEqual({ value: 14, status: 'suggested', vintage: '2023' });
  });
});

describe('publishing into a slot', () => {
  const rowFor = (extra) => ({
    _id: oid('9'), wineDefinition: WINE, key: acceptedKey, value: 14, status: 'suggested',
    suggestedBy: oid('7'), save: jest.fn().mockResolvedValue(undefined), ...extra,
  });

  test('an override supersedes ONLY that vintage slot; the default is untouched', async () => {
    const row = rowFor({ vintage: '2023' });
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    RegistryDataValue.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const res = await ops.decideValue(ADMIN, oid('9'), 'publish');
    expect(res.value).toMatchObject({ status: 'published', vintage: '2023' });
    expect(RegistryDataValue.updateOne).toHaveBeenCalledWith(
      { wineDefinition: WINE, key: KEY, vintage: '2023', status: 'published' },
      expect.anything()
    );
    expect(row.vintage).toBe('2023');
    expect(createNotification.mock.calls[0][3]).toMatch(/on the 2023 vintage/);
  });

  test('asWineDefault re-slots a vintage suggestion into the wine-wide default and says so', async () => {
    const row = rowFor({ vintage: '2023' });
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    RegistryDataValue.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await ops.decideValue(ADMIN, oid('9'), 'publish', undefined, { asWineDefault: true });
    expect(res.value).toMatchObject({ status: 'published', vintage: null });
    expect(RegistryDataValue.updateOne).toHaveBeenCalledWith(
      { wineDefinition: WINE, key: KEY, vintage: null, status: 'published' },
      expect.anything()
    );
    expect(row.vintage).toBeNull();
    expect(logAudit).toHaveBeenCalledWith(null, 'registry_data.value_publish', expect.anything(),
      expect.objectContaining({ vintage: null, widenedFrom: '2023' }));
    expect(createNotification.mock.calls[0][3]).toMatch(/every vintage/);
  });

  test('asWineDefault on a wine-wide suggestion is a plain publish (nothing to widen)', async () => {
    const row = rowFor({});
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    RegistryDataValue.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const res = await ops.decideValue(ADMIN, oid('9'), 'publish', undefined, { asWineDefault: true });
    expect(res.value.vintage).toBeNull();
    expect(logAudit.mock.calls[0][3]).not.toHaveProperty('widenedFrom');
    expect(createNotification.mock.calls[0][3]).toMatch(/published on the wine\./);
  });
});

describe('the review queue', () => {
  test('tells the reviewer what the wine says wine-wide for each vintage row, in one query', async () => {
    const queued = [
      { _id: oid('5'), vintage: '2023', value: 14, wineDefinition: { _id: WINE, name: 'SB' }, key: { _id: KEY, name: 'ABV' } },
      { _id: oid('6'), value: 12, wineDefinition: { _id: WINE, name: 'SB' }, key: { _id: KEY, name: 'ABV' } },
    ];
    RegistryDataKey.find.mockReturnValue(chain([]));
    RegistryDataValue.find
      .mockReturnValueOnce(chain(queued))
      .mockReturnValueOnce(chain([{ wineDefinition: WINE, key: KEY, value: 13.5 }]));

    const res = await ops.listReviewQueues();
    expect(res.values[0]).toMatchObject({ vintage: '2023', wineDefault: 13.5 });
    expect(res.values[1]).toMatchObject({ vintage: null });
    expect(res.values[1].wineDefault).toBeUndefined();
    expect(RegistryDataValue.find).toHaveBeenNthCalledWith(2, {
      $or: [{ wineDefinition: WINE, key: KEY, vintage: null, status: 'published' }],
    });
  });

  test('a vintage row whose wine has no default yet says so (null, not undefined)', async () => {
    RegistryDataKey.find.mockReturnValue(chain([]));
    RegistryDataValue.find
      .mockReturnValueOnce(chain([{ _id: oid('5'), vintage: '2023', value: 14, wineDefinition: { _id: WINE }, key: { _id: KEY } }]))
      .mockReturnValueOnce(chain([]));
    const res = await ops.listReviewQueues();
    expect(res.values[0].wineDefault).toBeNull();
  });

  test('a queue with no vintage rows never runs the defaults lookup', async () => {
    RegistryDataKey.find.mockReturnValue(chain([]));
    RegistryDataValue.find.mockReturnValueOnce(chain([{ _id: oid('6'), value: 12, wineDefinition: { _id: WINE }, key: { _id: KEY } }]));
    await ops.listReviewQueues();
    expect(RegistryDataValue.find).toHaveBeenCalledTimes(1);
  });
});
