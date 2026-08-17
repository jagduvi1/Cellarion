/**
 * registryDataOps (#985 Slice B) — the public vocabulary + values engine
 * shared by REST (user + admin) and MCP.
 *
 * Pins: key proposal validation (type system, rationale, RESERVED names,
 * live-name collision), the shared daily tier budget across keys+values,
 * value suggestions only against ACCEPTED keys with type validation, the
 * same-as-published no-op conflict, one-suggested-per-(wine,key) E11000
 * mapping, dataForWine's blanks-included shape, and the admin decisions —
 * including publish superseding a previously published value.
 */

jest.mock('../models/RegistryDataKey', () => ({
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(),
  countDocuments: jest.fn(), findOneAndUpdate: jest.fn(),
}));
jest.mock('../models/RegistryDataValue', () => ({
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(),
  countDocuments: jest.fn(), deleteOne: jest.fn(),
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('./wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
// registryDataOps imports TIER_DAILY from wineProposalOps — use the real one
// (it is a plain constant; no mocking needed) but keep its model deps quiet.
jest.mock('../models/WineCorrectionProposal', () => ({ countDocuments: jest.fn(), find: jest.fn(), create: jest.fn() }));

const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const User = require('../models/User');
const { findVisibleWine } = require('./wineVisibility');
const ops = require('./registryDataOps');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');
const KEY = oid('c');
const ADMIN = oid('d');

const acceptedKey = { _id: KEY, name: 'ABV', nameKey: 'abv', type: 'decimal', unit: '%', status: 'accepted' };

const mockUser = (tier = 'newcomer', banned = false) =>
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({ contribution: { tier }, isDiscussionBanned: () => banned }),
  });

const chain = (result) => {
  const c = {};
  for (const m of ['sort', 'populate', 'select', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUser();
  RegistryDataKey.countDocuments.mockResolvedValue(0);
  RegistryDataValue.countDocuments.mockResolvedValue(0);
  findVisibleWine.mockResolvedValue({ _id: WINE, producer: 'Cloudy Bay', name: 'Sauvignon Blanc' });
});

describe('proposeKey', () => {
  const GOOD = { name: 'ABV', type: 'decimal', unit: '%', rationale: 'Alcohol strength matters to every drinker.' };

  test('type-system validation and rationale bounds apply', async () => {
    expect((await ops.proposeKey(ME, { ...GOOD, type: 'percentage' })).code).toBe('invalid');
    expect((await ops.proposeKey(ME, { ...GOOD, rationale: 'short' })).code).toBe('invalid');
    expect((await ops.proposeKey(ME, { name: 'Closure', type: 'enum', enumOptions: ['cork'], rationale: GOOD.rationale })).code).toBe('invalid');
  });

  test('reserved names cannot shadow first-class fields', async () => {
    for (const name of ['producer', 'Region', 'FLAVORS']) {
      const res = await ops.proposeKey(ME, { ...GOOD, name });
      expect(res).toMatchObject({ ok: false, code: 'conflict' });
    }
    expect(RegistryDataKey.create).not.toHaveBeenCalled();
  });

  test('live-name collision: accepted → "suggest a value instead", proposed → "awaiting review"', async () => {
    RegistryDataKey.findOne.mockResolvedValue({ ...acceptedKey, status: 'accepted' });
    expect((await ops.proposeKey(ME, GOOD)).message).toContain('suggest a value');
    RegistryDataKey.findOne.mockResolvedValue({ ...acceptedKey, status: 'proposed' });
    expect((await ops.proposeKey(ME, GOOD)).message).toContain('awaiting review');
  });

  test('daily budget is SHARED across key proposals and value suggestions', async () => {
    RegistryDataKey.findOne.mockResolvedValue(null);
    RegistryDataKey.countDocuments.mockResolvedValue(2);
    RegistryDataValue.countDocuments.mockResolvedValue(1); // 2 + 1 = newcomer cap 3
    expect((await ops.proposeKey(ME, GOOD)).code).toBe('limit');
  });

  test('ban blocks; happy path creates the proposed key', async () => {
    mockUser('newcomer', true);
    expect((await ops.proposeKey(ME, GOOD)).code).toBe('banned');

    mockUser();
    RegistryDataKey.findOne.mockResolvedValue(null);
    RegistryDataKey.create.mockResolvedValue({ ...acceptedKey, status: 'proposed' });
    const res = await ops.proposeKey(ME, GOOD);
    expect(res.ok).toBe(true);
    expect(RegistryDataKey.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ABV', type: 'decimal', unit: '%', proposedBy: ME,
    }));
  });
});

describe('suggestValue', () => {
  const GOOD = { wineId: WINE, keyId: KEY, value: '13,5' };

  test('only ACCEPTED keys accept values', async () => {
    RegistryDataKey.findOne.mockResolvedValue(null);
    expect((await ops.suggestValue(ME, GOOD)).code).toBe('not_found');
    expect(RegistryDataKey.findOne).toHaveBeenCalledWith({ _id: { $eq: KEY }, status: 'accepted' });
  });

  test('value validated against the key type before any write', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    const res = await ops.suggestValue(ME, { ...GOOD, value: 'strong' });
    expect(res.code).toBe('invalid');
    expect(RegistryDataValue.create).not.toHaveBeenCalled();
  });

  test('same-as-published is a no-op conflict', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne.mockResolvedValue({ value: 13.5, status: 'published' });
    const res = await ops.suggestValue(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(res.message).toContain('already says');
  });

  test('creates the suggestion with the CAST value; E11000 → friendly conflict', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne.mockResolvedValue(null);
    RegistryDataValue.create.mockResolvedValue({ _id: oid('9'), value: 13.5, status: 'suggested' });

    const res = await ops.suggestValue(ME, GOOD);
    expect(res.ok).toBe(true);
    expect(RegistryDataValue.create).toHaveBeenCalledWith(expect.objectContaining({
      wineDefinition: WINE, key: KEY, value: 13.5, suggestedBy: ME,
    }));

    RegistryDataValue.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    expect((await ops.suggestValue(ME, GOOD)).code).toBe('conflict');
  });
});

describe('dataForWine', () => {
  test('every accepted key appears — blanks included — with published value + my pending suggestion', async () => {
    RegistryDataKey.find.mockReturnValue(chain([
      acceptedKey,
      { _id: oid('e'), name: 'Organic', nameKey: 'organic', type: 'boolean', status: 'accepted' },
    ]));
    RegistryDataValue.find
      .mockReturnValueOnce(chain([{ key: KEY, value: 13.5, suggestedBy: { username: 'kurt' } }]))
      .mockReturnValueOnce(chain([{ key: oid('e'), value: true, status: 'suggested' }]));

    const res = await ops.dataForWine(WINE, ME);
    expect(res.fields).toHaveLength(2);
    expect(res.fields[0]).toMatchObject({ value: 13.5, contributedBy: 'kurt', mySuggestion: null });
    expect(res.fields[1]).toMatchObject({ value: null, mySuggestion: { value: true } });
  });
});

describe('admin decisions', () => {
  test('decideKey accepts only a still-proposed row', async () => {
    RegistryDataKey.findOneAndUpdate.mockResolvedValue({ ...acceptedKey, status: 'accepted' });
    const res = await ops.decideKey(ADMIN, KEY, 'accept');
    expect(res.ok).toBe(true);
    expect(RegistryDataKey.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: { $eq: KEY }, status: 'proposed' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'accepted', decidedBy: ADMIN }) }),
      { new: true }
    );

    RegistryDataKey.findOneAndUpdate.mockResolvedValue(null);
    expect((await ops.decideKey(ADMIN, KEY, 'accept')).code).toBe('not_found');
    expect((await ops.decideKey(ADMIN, KEY, 'publish')).code).toBe('invalid');
  });

  test('publish supersedes the previously published value for that wine+key', async () => {
    const row = {
      _id: oid('9'), wineDefinition: WINE, key: acceptedKey, value: 14,
      status: 'suggested', save: jest.fn().mockResolvedValue(undefined),
    };
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    RegistryDataValue.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const res = await ops.decideValue(ADMIN, oid('9'), 'publish');
    expect(res.ok).toBe(true);
    expect(RegistryDataValue.deleteOne).toHaveBeenCalledWith({
      wineDefinition: WINE, key: KEY, status: 'published',
    });
    expect(row.status).toBe('published');
    expect(row.save).toHaveBeenCalled();
  });

  test('reject keeps the row as history and never touches the published slot', async () => {
    const row = {
      _id: oid('9'), wineDefinition: WINE, key: acceptedKey, value: 14,
      status: 'suggested', save: jest.fn().mockResolvedValue(undefined),
    };
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    const res = await ops.decideValue(ADMIN, oid('9'), 'reject', 'no evidence');
    expect(res.ok).toBe(true);
    expect(row.status).toBe('rejected');
    expect(RegistryDataValue.deleteOne).not.toHaveBeenCalled();
  });
});
