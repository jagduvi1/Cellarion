/**
 * GET /api/admin/wines/fragmentation — the SAME-WINE fragmentation queues
 * (curator ticket d4a0e96b). The detectors live in
 * services/registryFragmentation (unit-tested there); this suite pins the
 * route contract: mode switching, the producer-in-name-style pagination
 * envelope, mode validation, and that the pairs envelope carries the
 * skippedBuckets warning.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  ctor.countDocuments = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn() }));
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
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../../services/registryFragmentation', () => ({
  sameProducerAppellationGroups: jest.fn(),
  nearProducerPairs: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { sameProducerAppellationGroups, nearProducerPairs } = require('../../services/registryFragmentation');
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
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
});

const getFragmentation = (qs = '') => fetch(`${baseUrl}/api/admin/wines/fragmentation${qs}`, {
  headers: { Authorization: `Bearer ${adminToken()}` },
});

test('default mode is groups: paginated envelope around the service result', async () => {
  const group = {
    key: 'caronne saintegemme|haut medoc',
    producer: 'Château Caronne Sainte-Gemme',
    appellation: 'Haut-Médoc',
    disjoint: true,
    wines: [{ _id: 'w1', name: 'Haut-Médoc', producer: 'Château Caronne Sainte-Gemme', vintages: ['2016'], bottleCount: 3 }],
  };
  sameProducerAppellationGroups.mockResolvedValue({ groups: [group], total: 7, scannedCount: 5500 });

  const res = await getFragmentation();
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toEqual({ groups: [group], total: 7, page: 1, pages: 1, scannedCount: 5500 });
  expect(sameProducerAppellationGroups).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  expect(nearProducerPairs).not.toHaveBeenCalled();
});

test('mode=pairs passes parsed pagination through and keeps the skippedBuckets warning', async () => {
  nearProducerPairs.mockResolvedValue({ pairs: [], total: 41, scannedCount: 5500, skippedBuckets: 2 });

  const res = await getFragmentation('?mode=pairs&limit=10&offset=20');
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toEqual({ pairs: [], total: 41, page: 3, pages: 5, scannedCount: 5500, skippedBuckets: 2 });
  expect(nearProducerPairs).toHaveBeenCalledWith({ limit: 10, offset: 20 });
  expect(sameProducerAppellationGroups).not.toHaveBeenCalled();
});

test('an unknown mode is rejected with 400 and no scan runs', async () => {
  const res = await getFragmentation('?mode=everything');
  expect(res.status).toBe(400);
  expect(sameProducerAppellationGroups).not.toHaveBeenCalled();
  expect(nearProducerPairs).not.toHaveBeenCalled();
});
