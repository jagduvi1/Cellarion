/**
 * Vintage-scoped personal data (user ticket 6a853211): "Every bottle of this
 * vintage" — a wine-level entry narrowed to the bottle's vintage, because
 * values like ABV drift year to year. Pins: the vintage is DERIVED from the
 * bottle (never client text), scope only exists on wine-level entries, and
 * the bottle listing filters vintage-scoped entries to matching bottles.
 */
jest.mock('../models/PersonalDataEntry', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn();
  ctor.create = jest.fn();
  ctor.countDocuments = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../models/PersonalDataKey', () => ({ findOne: jest.fn(), create: jest.fn(), countDocuments: jest.fn(), find: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));

const User = require('../models/User');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const PersonalDataKey = require('../models/PersonalDataKey');
const personalData = require('./personalData');

const oid = (c) => c.repeat(24);
const KEY = { _id: oid('f'), name: 'ABV', type: 'decimal', unit: '%' };
const BOTTLE = { _id: oid('b'), wineDefinition: oid('d'), vintage: '2019' };
const CELLAR = { owner: oid('a'), sharedWith: [] };

const findChain = (rows) => ({
  sort: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(rows),
});

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue({ isDiscussionBanned: () => false }) });
  PersonalDataKey.findOne.mockResolvedValue(KEY);
  PersonalDataEntry.countDocuments.mockResolvedValue(0);
  PersonalDataEntry.create.mockImplementation(async (doc) => ({
    ...doc, _id: oid('e'), key: KEY, author: { _id: oid('a') },
    populate: jest.fn().mockResolvedValue(undefined),
  }));
});

test('vintage-scoped create derives the vintage from the BOTTLE, never the client', async () => {
  const res = await personalData.createEntry(oid('a'), BOTTLE, {
    level: 'wine', keyId: oid('f'), value: 13.5, vintageScoped: true,
  });
  expect(res.ok).toBe(true);
  expect(PersonalDataEntry.create).toHaveBeenCalledWith(expect.objectContaining({
    targetType: 'wine', wineDefinition: BOTTLE.wineDefinition, vintage: '2019',
  }));
});

test('an unscoped wine-level entry carries no vintage', async () => {
  await personalData.createEntry(oid('a'), BOTTLE, { level: 'wine', keyId: oid('f'), value: 13.5 });
  const doc = PersonalDataEntry.create.mock.calls[0][0];
  expect(doc.vintage).toBeUndefined();
});

test('vintage scope is refused on bottle-level entries and on vintage-less bottles', async () => {
  let res = await personalData.createEntry(oid('a'), BOTTLE, {
    level: 'bottle', keyId: oid('f'), value: 13.5, vintageScoped: true,
  });
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/wine-level/);

  res = await personalData.createEntry(oid('a'), { ...BOTTLE, vintage: '' }, {
    level: 'wine', keyId: oid('f'), value: 13.5, vintageScoped: true,
  });
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/no vintage/);
});

test('listForBottle filters vintage-scoped wine entries to the bottle vintage', async () => {
  PersonalDataEntry.find.mockImplementation(() => findChain([]));
  await personalData.listForBottle(BOTTLE, CELLAR);
  const wineFilter = PersonalDataEntry.find.mock.calls.find((c) => c[0].wineDefinition)[0];
  expect(wineFilter.$or).toEqual([{ vintage: null }, { vintage: '2019' }]);
});
