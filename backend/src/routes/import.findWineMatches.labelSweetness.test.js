/**
 * The import's candidate finder and the label sweetness term (GitHub
 * discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * findWineMatches annotates every registry candidate with styleConflict, the
 * verdict the import's preselection and its >= EXACT gates read (issue #1134).
 * The guard reads a candidate's RECORDED term before its name, which it can
 * only do when the candidate load populates the term: with a bare id and a
 * cold term table it reads "no term", and once the word has left the names a
 * file row "… trocken" would preselect the registry's halbtrocken. Harness
 * cloned from import.aiBypass.test.js; WineDefinition records its populate.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }), indexWine: () => {}, bulkIndexBottles: jest.fn() }));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/priceWarnings', () => ({ computeUserMediansByCurrency: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/Bottle', () => function Bottle() {});
jest.mock('../models/WineRequest', () => function WineRequest() {});
jest.mock('../models/Rack', () => { const model = { find: jest.fn() }; model.RACK_TYPES = ['grid']; return model; });
jest.mock('../models/WineDefinition', () => {
  const state = { candidates: [], populates: [] };
  const chain = (docs) => {
    const c = { populate: jest.fn((spec) => { state.populates.push(spec); return c; }), sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  return {
    findOne: jest.fn(() => ({ populate: async () => null, select: () => ({ lean: async () => null }) })),
    find: jest.fn(() => chain(state.candidates)),
    findById: jest.fn(),
    __state: state,
  };
});
jest.mock('../models/Grape', () => ({ find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));
jest.mock('../models/AiUsage', () => ({ findOneAndUpdate: jest.fn(async () => ({ count: 0 })) }));
jest.mock('../models/User', () => ({ findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })) }));

const WineDefinition = require('../models/WineDefinition');
const { findWineMatches } = require('./import');

const VIEWER = { userId: '64b000000000000000000001', roles: ['user'] };
const ITEM = { wineName: 'Riesling Spätlese trocken', producer: 'Weingut Keller', appellation: 'Rheinhessen', country: 'Germany' };
const candidate = (labelSweetness) => ({
  _id: { toString: () => '64b0000000000000000000c1' }, name: 'Riesling Spätlese', producer: 'Weingut Keller', appellation: 'Rheinhessen', type: 'white',
  country: { name: 'Germany' }, grapes: [], labelSweetness,
});

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.__state.candidates = [];
  WineDefinition.__state.populates = [];
});

test('every candidate load populates the term', async () => {
  WineDefinition.__state.candidates = [candidate(null)];
  await findWineMatches(ITEM, VIEWER);
  expect(WineDefinition.__state.populates.length).toBeGreaterThan(0);
  for (const spec of WineDefinition.__state.populates) {
    expect(spec).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'labelSweetness' })]));
  }
});

test('a populated candidate that RECORDS halbtrocken carries a styleConflict for a file row stating trocken', async () => {
  WineDefinition.__state.candidates = [candidate({ name: 'halbtrocken', band: 'off-dry', scale: 'still', regulated: true })];
  const matches = await findWineMatches(ITEM, VIEWER);
  expect(matches).toHaveLength(1);
  expect(matches[0].styleConflict).toMatch(/different sweetness/);
});

test('the same candidate with an UNPOPULATED ref (cold term table) carries none — which is why the populate is load-bearing', async () => {
  WineDefinition.__state.candidates = [candidate({ toString: () => '64b0000000000000000000f1' })];
  const matches = await findWineMatches(ITEM, VIEWER);
  expect(matches).toHaveLength(1);
  expect(matches[0].styleConflict).toBeNull();
});

test('a populated candidate recording the same word is no conflict', async () => {
  WineDefinition.__state.candidates = [candidate({ name: 'trocken', band: 'dry', scale: 'still', regulated: true })];
  const matches = await findWineMatches(ITEM, VIEWER);
  expect(matches[0].styleConflict).toBeNull();
});
