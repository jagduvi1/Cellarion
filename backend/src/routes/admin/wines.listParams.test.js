/**
 * GET /api/admin/wines: a query parameter that is not one plain value.
 *
 * Express hands a repeated parameter over as an array and `?search[$gt]=1` as
 * an object. The list read `search`, `type` and `sort` as they came, so either
 * shape reached the text search and answered 500. Each is now one string or
 * nothing.
 */


process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  ctor.countDocuments = jest.fn();
  ctor.bulkWrite = jest.fn();
  ctor.updateMany = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../../models/BottleImage', () => ({}));
jest.mock('../../models/WineVintageProfile', () => ({ deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }) }));
jest.mock('../../models/WineVintagePrice', () => ({}));
jest.mock('../../models/WineReport', () => ({}));
jest.mock('../../models/Review', () => ({}));
jest.mock('../../models/Discussion', () => ({}));
jest.mock('../../models/DiscussionReply', () => ({}));
jest.mock('../../models/WineEmbedding', () => ({ deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }) }));
jest.mock('../../models/WineNotDuplicate', () => ({ find: jest.fn() }));
jest.mock('../../models/WineList', () => ({}));
jest.mock('../../models/WishlistItem', () => ({}));
jest.mock('../../models/PriceTrackingRequest', () => ({}));
jest.mock('../../models/PriceTrackingSkip', () => ({}));
jest.mock('../../models/CommunityWinePrice', () => ({}));
jest.mock('../../models/JournalEntry', () => ({}));
jest.mock('../../models/Recommendation', () => ({}));
jest.mock('../../models/RestockAlert', () => ({}));
jest.mock('../../models/WineRequest', () => ({}));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn(), reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn(), getIsAvailable: jest.fn(() => false), search: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
// The non-wine proposals' Cellar Cred follows the quarantine (suggestionCred.test.js).
jest.mock('../../services/suggestionCred', () => ({
  settleNonWineProposals: jest.fn().mockResolvedValue({ awarded: 0, reversed: 0 }),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wines', adminWinesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

let finds;
beforeEach(() => {
  jest.clearAllMocks();
  finds = [];
  WineDefinition.find.mockImplementation((query) => {
    const rec = { query, sort: null };
    finds.push(rec);
    const chain = { select: () => chain, populate: () => chain, sort: (s) => { rec.sort = s; return chain; }, skip: () => chain, limit: async () => [] };
    return chain;
  });
  WineDefinition.countDocuments.mockResolvedValue(0);
});

const list = (qs) => fetch(`${baseUrl}/api/admin/wines?${qs}`, { headers: { Authorization: `Bearer ${adminToken()}` } });

test('a plain search, type and sort reach the query as they are', async () => {
  const res = await list('search=barolo&type=red&sort=-name');
  expect(res.status).toBe(200);
  expect(finds[0].query).toEqual({ $and: [{ $text: { $search: 'barolo' } }, { type: 'red' }], draft: { $ne: true } });
  expect(finds[0].sort).toEqual({ score: { $meta: 'textScore' }, name: -1 });
});

test.each([
  ['repeated', 'search=barolo&search=barbera'],
  ['shaped like an operator', 'search[$gt]=1'],
  ['a nested list', 'search[]=barolo&search[]=barbera'],
])('a search that is %s is ignored: the list answers unsearched, not with a 500', async (name, qs) => {
  const res = await list(qs);
  expect(res.status).toBe(200);
  expect(finds[0].query).toEqual({ draft: { $ne: true } });
  expect(searchService.search).not.toHaveBeenCalled();
});

test('a type or a sort that is not one plain value is ignored as well', async () => {
  const res = await list('type=red&type=white&sort[$gt]=1');
  expect(res.status).toBe(200);
  expect(finds[0].query).toEqual({ draft: { $ne: true } });
  expect(finds[0].sort).toEqual({ name: 1 });
});
