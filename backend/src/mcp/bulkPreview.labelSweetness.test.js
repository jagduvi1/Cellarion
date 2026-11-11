/**
 * bulk_add's preview and the label sweetness term (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * A plan item built from a wine_id is summarised with `termLoaded: true`, so
 * the summary EMITS label_sweetness/display_name as facts. That is honest only
 * when the read populated the term: with country/region/grapes alone the
 * summary would state "no term" for every termed wine in the plan, and the
 * model would show the user a bare name for a wine whose label says
 * "trocken". Mock style follows bulkTools.test.js.
 */
const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn(), CURATION_ROLES: ['somm', 'admin'] }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), ipKeyFor: jest.fn(() => null), WRITE_WINDOW_MS: 15 * 60 * 1000 }));

const Cellar = require('../models/Cellar');
const McpActionLog = require('../models/McpActionLog');
const { findVisibleWine } = require('../services/wineVisibility');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const CTX = { user: { id: ME, roles: [] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {}, apiToken: { id: 't1' } } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const TROCKEN = { name: 'trocken', band: 'dry', scale: 'still', regulated: true };

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));
  McpActionLog.create.mockResolvedValue({ _id: oid('9') });
  McpActionLog.find.mockReturnValue(chain([]));
  McpActionLog.deleteMany.mockResolvedValue({ deletedCount: 0 });
});

test('a wine_id item is read WITH its term populated, and the plan states the term and the display name', async () => {
  findVisibleWine.mockResolvedValue({
    _id: oid('f'), name: 'Riesling Kabinett', producer: 'Weingut Keller', type: 'white', grapes: [], labelSweetness: TROCKEN,
  });
  const res = await tool('bulk_add').handler({ cellar_id: oid('c'), items: [{ wine_id: oid('f') }] }, CTX);
  const item = parse(res).data.plan[0];
  expect(item.status).toBe('ready');
  expect(item.wine.label_sweetness).toEqual(TROCKEN);
  expect(item.wine.display_name).toBe('Riesling Kabinett trocken');

  // The populate the read ran — a path for the term, with the row's shape and no id.
  const populate = findVisibleWine.mock.calls[0][1].populate;
  const term = populate.find((p) => p && p.path === 'labelSweetness');
  expect(term).toBeDefined();
  expect(term.select.split(/\s+/)).toEqual(expect.arrayContaining(['name', 'band', 'scale', 'regulated', '-_id']));
});

test('a wine_id item without a term states none (never a missing key) — the row was read with the field', async () => {
  findVisibleWine.mockResolvedValue({ _id: oid('f'), name: 'Barolo', producer: 'Mascarello', type: 'red', grapes: [], labelSweetness: null });
  const res = await tool('bulk_add').handler({ cellar_id: oid('c'), items: [{ wine_id: oid('f') }] }, CTX);
  const item = parse(res).data.plan[0];
  expect(item.wine).toHaveProperty('label_sweetness', null);
  expect(item.wine.display_name).toBe('Barolo');
});
