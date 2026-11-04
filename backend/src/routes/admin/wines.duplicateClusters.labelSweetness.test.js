/**
 * GET /api/admin/wines/duplicate-clusters and the label sweetness term
 * (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * The cluster scan skips a pair whose records state different styles (issue
 * #1134: a producer's range is not a duplicate set). That verdict reads a
 * row's RECORDED term before its name, so the scan must load and populate the
 * term: with bare ids and a cold term table two rows that are the trocken and
 * the halbtrocken of one vineyard cluster as one merge proposal. Mock style
 * follows wines.duplicates.test.js.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn(); ctor.findById = jest.fn(); ctor.findOne = jest.fn(); ctor.countDocuments = jest.fn();
  ctor.bulkWrite = jest.fn(); ctor.updateMany = jest.fn(); ctor.updateOne = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../../models/BottleImage', () => ({}));
jest.mock('../../models/WineVintageProfile', () => ({}));
jest.mock('../../models/WineVintagePrice', () => ({}));
jest.mock('../../models/WineReport', () => ({}));
jest.mock('../../models/Review', () => ({}));
jest.mock('../../models/Discussion', () => ({}));
jest.mock('../../models/DiscussionReply', () => ({}));
jest.mock('../../models/WineEmbedding', () => ({}));
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
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn(), bulkIndexBottles: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const WineNotDuplicate = require('../../models/WineNotDuplicate');
const adminWinesRouter = require('./wines');

const adminToken = () => jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wines', adminWinesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const get = async () => {
  const res = await fetch(`${baseUrl}/api/admin/wines/duplicate-clusters?minScore=0.6`, { headers: { Authorization: `Bearer ${adminToken()}` } });
  return { status: res.status, body: await res.json() };
};

let chain;
const pool = (rows) => {
  chain = { select: jest.fn(() => chain), populate: jest.fn(() => chain), lean: jest.fn(async () => rows) };
  WineDefinition.find.mockReturnValue(chain);
};
const row = (id, labelSweetness) => ({ _id: id, name: 'Riesling Spätlese', producer: 'Weingut Keller', appellation: 'Rheinhessen', type: 'white', labelSweetness });
const TROCKEN = { name: 'trocken', band: 'dry', scale: 'still', regulated: true };
const HALBTROCKEN = { name: 'halbtrocken', band: 'off-dry', scale: 'still', regulated: true };

beforeEach(() => {
  jest.clearAllMocks();
  WineNotDuplicate.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  Bottle.aggregate.mockResolvedValue([]);
});

test('the scan loads and populates the term', async () => {
  pool([]);
  expect((await get()).status).toBe(200);
  expect(chain.select.mock.calls[0][0].split(/\s+/)).toContain('labelSweetness');
  expect(chain.populate).toHaveBeenCalledWith('labelSweetness', 'name band scale regulated -_id');
});

test('the trocken and the halbtrocken of one vineyard, populated, are NOT one cluster', async () => {
  pool([row('64b0000000000000000000c1', TROCKEN), row('64b0000000000000000000c2', HALBTROCKEN)]);
  const { body } = await get();
  expect(body.scannedCount).toBe(2);
  expect(body.clusters).toEqual([]);
});

test('the same two rows with UNPOPULATED refs (cold term table) WOULD cluster — which is why the populate is load-bearing', async () => {
  pool([row('64b0000000000000000000c1', { toString: () => '64b0000000000000000000f1' }), row('64b0000000000000000000c2', { toString: () => '64b0000000000000000000f2' })]);
  const { body } = await get();
  expect(body.clusters).toHaveLength(1);
  expect(body.clusters[0].wines).toHaveLength(2);
});

test('two rows recording the same word still cluster as the duplicates they are', async () => {
  pool([row('64b0000000000000000000c1', TROCKEN), row('64b0000000000000000000c2', TROCKEN)]);
  const { body } = await get();
  expect(body.clusters).toHaveLength(1);
});
