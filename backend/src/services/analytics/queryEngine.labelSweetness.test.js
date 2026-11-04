/**
 * The analytics engine and the label sweetness term (GitHub discussion #1754):
 * rows mode loads and populates the term so the taxonomy extractor can name
 * it, and grouped mode resolves the bucket ids to term names. Same mocks as
 * queryEngine.test.
 */
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), find: jest.fn() }));
jest.mock('../../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../../models/PersonalDataEntry', () => ({ find: jest.fn() }));
jest.mock('../../models/RegistryDataValue', () => ({ find: jest.fn() }));
jest.mock('../../models/PersonalDataKey', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/RegistryDataKey', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn(async () => ({ rates: { USD: 1, EUR: 0.9, SEK: 10 } })),
  convertCurrency: jest.requireActual('../../utils/exchangeRates').convertCurrency,
}));
jest.mock('../../utils/maturityUtils', () => ({
  classifyMaturity: jest.fn(() => 'ready'),
  buildProfileMap: jest.fn(async () => new Map()),
  resolveEffectiveWindow: jest.fn(() => null),
}));

const Bottle = require('../../models/Bottle');
const Cellar = require('../../models/Cellar');
const Rack = require('../../models/Rack');
const PersonalDataEntry = require('../../models/PersonalDataEntry');
const RegistryDataValue = require('../../models/RegistryDataValue');
const PersonalDataKey = require('../../models/PersonalDataKey');
const RegistryDataKey = require('../../models/RegistryDataKey');
const SweetnessTerm = require('../../models/SweetnessTerm');
const { runQuery } = require('./queryEngine');

const USER = 'a'.repeat(24);
const CELLAR_A = 'b'.repeat(24);
const B1 = 'e'.repeat(24);
const W1 = 'f'.repeat(24);
const T1 = '1'.repeat(24);

const chainLean = (docs) => {
  const c = {};
  for (const m of ['select', 'limit', 'sort', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => docs);
  return c;
};
const aggReturning = (result) => {
  const captured = { pipelines: [] };
  Bottle.aggregate.mockImplementation((pipeline) => {
    captured.pipelines.push(pipeline);
    return { option: jest.fn(async () => result) };
  });
  return captured;
};

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.find.mockReturnValue(chainLean([{ _id: CELLAR_A, name: 'Home', user: USER, members: [] }]));
  Rack.find.mockReturnValue(chainLean([]));
  PersonalDataEntry.find.mockReturnValue(chainLean([]));
  RegistryDataValue.find.mockReturnValue(chainLean([]));
  PersonalDataKey.find.mockReturnValue(chainLean([]));
  RegistryDataKey.find.mockReturnValue(chainLean([]));
});
afterEach(() => jest.restoreAllMocks());

test('rows mode: the term is loaded, populated and named like every taxonomy column', async () => {
  aggReturning([{ ids: [{ _id: B1 }], total: [{ n: 1 }] }]);
  const chain = chainLean([{
    _id: B1, cellar: CELLAR_A, vintage: '2019',
    wineDefinition: { _id: W1, producer: 'Weingut Keller', name: 'Riesling Kabinett', labelSweetness: { _id: T1, name: 'trocken' } },
  }]);
  Bottle.find.mockReturnValue(chain);
  const out = await runQuery(USER, { columns: ['wine.name', 'wine.labelSweetness'] });
  expect(out.rows[0].values).toEqual({ 'wine.name': 'Riesling Kabinett', 'wine.labelSweetness': 'trocken' });
  const spec = chain.populate.mock.calls[0][0];
  expect(spec.select.split(/\s+/)).toContain('labelSweetness');
  expect(spec.populate).toEqual(expect.arrayContaining([{ path: 'labelSweetness', select: 'name' }]));
});

test('rows mode: a wine without a term reads null, not an id', async () => {
  aggReturning([{ ids: [{ _id: B1 }], total: [{ n: 1 }] }]);
  Bottle.find.mockReturnValue(chainLean([{ _id: B1, cellar: CELLAR_A, wineDefinition: { _id: W1, name: 'Barolo', labelSweetness: null } }]));
  const out = await runQuery(USER, { columns: ['wine.labelSweetness'] });
  expect(out.rows[0].values).toEqual({ 'wine.labelSweetness': null });
});

test('grouped mode: buckets by the term and names them from the term table', async () => {
  const cap = aggReturning([{ _id: { d0: T1 }, m0: 4 }, { _id: { d0: null }, m0: 9 }]);
  jest.spyOn(SweetnessTerm, 'find').mockReturnValue({ select: () => ({ lean: async () => [{ _id: T1, name: 'trocken' }] }) });
  const out = await runQuery(USER, { mode: 'grouped', dimensions: ['wine.labelSweetness'], measures: [{ field: '*', agg: 'count' }] });
  const group = cap.pipelines[0].find((s) => s.$group).$group;
  expect(group._id).toEqual({ d0: '$wd.labelSweetness' });
  expect(out.buckets.map((b) => [b.dimensions[0], b.measures[0]])).toEqual([['trocken', 4], [null, 9]]);
});
