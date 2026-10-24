/**
 * Rows mode hydrates personal and registry columns with one query per source
 * over the page's wine ids. A bottle with no registry wine yet (no
 * wineDefinition, or one stored as null) has no wine id to contribute: it
 * must not put a stringified "undefined"/"null" into that list, which the
 * real models refuse to cast — the whole page would fail.
 *
 * The two KV models are mocked, but their find() casts the filter with the
 * real schema first, so a cast error surfaces exactly as it would in MongoDB.
 */

jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), find: jest.fn() }));
jest.mock('../../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../../models/PersonalDataEntry', () => ({ find: jest.fn() }));
jest.mock('../../models/RegistryDataValue', () => ({ find: jest.fn() }));
jest.mock('../../models/PersonalDataKey', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/RegistryDataKey', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn(async () => ({ rates: { USD: 1 } })),
  convertCurrency: jest.requireActual('../../utils/exchangeRates').convertCurrency,
}));
jest.mock('../../utils/maturityUtils', () => ({
  classifyMaturity: jest.fn(() => 'ready'),
  buildProfileMap: jest.fn(async () => new Map()),
  resolveEffectiveWindow: jest.fn(() => null),
}));

const mongoose = require('mongoose');
const Bottle = require('../../models/Bottle');
const Cellar = require('../../models/Cellar');
const PersonalDataEntry = require('../../models/PersonalDataEntry');
const RegistryDataValue = require('../../models/RegistryDataValue');
const PersonalDataKey = require('../../models/PersonalDataKey');
const RegistryDataKey = require('../../models/RegistryDataKey');
const { runQuery } = require('./queryEngine');

const RealPersonalDataEntry = jest.requireActual('../../models/PersonalDataEntry');
const RealRegistryDataValue = jest.requireActual('../../models/RegistryDataValue');

const USER = 'a'.repeat(24);
const CELLAR = 'b'.repeat(24);
const KEY_ID = 'd'.repeat(24);
const WINE = new mongoose.Types.ObjectId('e'.repeat(24));
const NO_FIELD = new mongoose.Types.ObjectId('1'.repeat(24));
const NULL_WINE = new mongoose.Types.ObjectId('2'.repeat(24));
const WITH_WINE = new mongoose.Types.ObjectId('3'.repeat(24));

const chainLean = (docs) => {
  const c = {};
  for (const m of ['select', 'limit', 'sort', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => docs);
  return c;
};

/** A mocked find() that casts its filter with the real model, as MongoDB would. */
const castingFind = (Real, docs) => (filter) => {
  Real.find(filter).cast(Real);
  return chainLean(docs);
};

// The page: a bottle without the field, one with it stored as null (populate
// leaves both empty), and one with a wine.
const PAGE = [
  { _id: NO_FIELD, cellar: CELLAR, status: 'active', vintage: '2019' },
  { _id: NULL_WINE, cellar: CELLAR, status: 'active', vintage: '2020', wineDefinition: null },
  { _id: WITH_WINE, cellar: CELLAR, status: 'active', vintage: '2018', wineDefinition: { _id: WINE, name: 'Barolo' } },
];

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.find.mockReturnValue(chainLean([{ _id: CELLAR, name: 'Home' }]));
  Bottle.aggregate.mockReturnValue({
    option: jest.fn(async () => [{ ids: PAGE.map((b) => ({ _id: b._id })), total: [{ n: PAGE.length }] }]),
  });
  Bottle.find.mockReturnValue(chainLean(PAGE));
});

test('a personal column hydrates a page that holds bottles with no wine yet', async () => {
  PersonalDataKey.findOne.mockReturnValue({ lean: async () => ({ _id: KEY_ID, user: USER, name: 'Shelf', type: 'text' }) });
  PersonalDataEntry.find.mockImplementation(castingFind(RealPersonalDataEntry, [
    { author: USER, key: KEY_ID, targetType: 'bottle', bottle: NO_FIELD, value: 'top' },
    { author: USER, key: KEY_ID, targetType: 'wine', wineDefinition: WINE, value: 'cellar door' },
  ]));
  const field = `personal.${KEY_ID}`;

  const out = await runQuery(USER, { columns: [field] });

  const wineArm = PersonalDataEntry.find.mock.calls[0][0].$or.find((c) => c.targetType === 'wine');
  expect(wineArm.wineDefinition.$in).toEqual([String(WINE)]);
  expect(out.rows.map((r) => r.values[field])).toEqual(['top', null, 'cellar door']);
});

test('a registry column hydrates a page that holds bottles with no wine yet', async () => {
  RegistryDataKey.findOne.mockReturnValue({ lean: async () => ({ _id: KEY_ID, status: 'accepted', name: 'Closure', type: 'text' }) });
  RegistryDataValue.find.mockImplementation(castingFind(RealRegistryDataValue, [
    { wineDefinition: WINE, key: KEY_ID, status: 'published', vintage: null, value: 'cork' },
  ]));
  const field = `registry.${KEY_ID}`;

  const out = await runQuery(USER, { columns: [field] });

  expect(RegistryDataValue.find.mock.calls[0][0].wineDefinition.$in).toEqual([String(WINE)]);
  expect(out.rows.map((r) => r.values[field])).toEqual([null, null, 'cork']);
});
