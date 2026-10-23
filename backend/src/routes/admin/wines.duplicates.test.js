/**
 * GET /api/admin/wines/duplicates — the duplicate hint under the wine-request
 * review form.
 *
 * It read req.query raw (a repeated param is an array → name.split() threw →
 * 500; ?threshold=abc → NaN → nothing passed the filter) and scored with its
 * own February composite on raw strings, so a producer variant ("Kumeu River"
 * vs "Kumeu River Wines Limited") scored ~0.72-0.77 and dropped under the
 * hint's 0.75 floor while every add flow, on the shared scorer, calls it the
 * same winery. Mock style follows wines.reenrichOnEdit.test.js.
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
  ctor.updateOne = jest.fn();
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

const get = async (qs) => {
  const res = await fetch(`${baseUrl}/api/admin/wines/duplicates?${qs}`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  return { status: res.status, body: await res.json() };
};

const wine = (id, name, producer, appellation = null) => ({
  _id: { toString: () => id }, name, producer, appellation,
});
// Both candidate queries (text + regex) answer the same pool; the route
// dedupes by id.
const pool = (list) => WineDefinition.find.mockImplementation(() => ({
  populate: () => ({ limit: () => Promise.resolve(list) }),
}));

beforeEach(() => jest.clearAllMocks());

test('a repeated name param is a 400 and no query runs', async () => {
  const { status, body } = await get('name=a&name=b&producer=x');
  expect(status).toBe(400);
  expect(body.error).toBe('Name and producer are required');
  expect(WineDefinition.find).not.toHaveBeenCalled();
});

test('a malformed threshold falls back to 0.75 instead of filtering everything out', async () => {
  pool([
    wine('w1', "Maté's Vineyard Chardonnay", 'Kumeu River', 'Kumeu'),
    wine('w2', 'Gimblett Gravels Syrah', 'Trinity Hill', "Hawke's Bay"),
  ]);
  const { status, body } = await get(`name=${encodeURIComponent("Maté's Vineyard Chardonnay")}&producer=Kumeu%20River&threshold=abc`);
  expect(status).toBe(200);
  expect(body.threshold).toBe(0.75);
  expect(body.candidates.map((c) => c.wine.name)).toEqual(["Maté's Vineyard Chardonnay"]);
});

test('a producer variant of the same winery scores as the add flows score it, and ranks first', async () => {
  pool([
    wine('w1', "Maté's Vineyard", 'Kumeu River', 'Kumeu'),
    wine('w2', "Maté's Vineyard Chardonnay", 'Kumeu River Wines Limited', 'Kumeu'),
  ]);
  const { status, body } = await get(`name=${encodeURIComponent("Maté's Vineyard Chardonnay")}&producer=Kumeu%20River&threshold=0.75`);
  expect(status).toBe(200);
  expect(body.candidates[0].wine.producer).toBe('Kumeu River Wines Limited');
  expect(body.candidates[0].similarity).toBeGreaterThanOrEqual(0.9);
});

test('the per-algorithm breakdown is still on every candidate, with overall = the shared score', async () => {
  pool([wine('w1', "Maté's Vineyard Chardonnay", 'Kumeu River Wines Limited', 'Kumeu')]);
  const { body } = await get(`name=${encodeURIComponent("Maté's Vineyard Chardonnay")}&producer=Kumeu%20River&appellation=Kumeu&threshold=0.75`);
  const c = body.candidates[0];
  for (const axis of ['name', 'producer']) {
    expect(Object.keys(c.scores[axis]).sort()).toEqual(['combined', 'levenshtein', 'token', 'trigram']);
  }
  expect(typeof c.scores.appellation).toBe('number');
  expect(c.scores.overall).toBe(Math.round(c.similarity * 100) / 100);
});
