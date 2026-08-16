/**
 * PUT /api/admin/wines/:id — the re-enrich follow-through fires on a REAL
 * change only.
 *
 * The v1.116.0 hook checked presence-in-body (`name || producer`), and the
 * admin edit form re-sends every field on save — so every save would have
 * regenerated the AI profile and churned generatedAt (resurfacing reviewed
 * rows in the low-confidence queue) even when nothing changed. The decision
 * is now a before/after profileInputsSnapshot comparison handed to
 * reenrichAfterRecordEdit (curator/never-enriched gates live in that helper,
 * pinned by enrichmentJob.test.js). Mock style follows wines.nonWine.test.js.
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
jest.mock('../../services/enrichmentJob', () => ({
  reenrichAfterRecordEdit: jest.fn(),
  enrichWineById: jest.fn(),
  releaseHeldProfile: jest.fn().mockResolvedValue(true),
  // The REAL snapshot — pure and dependency-free, so nothing is gained by
  // mirroring it, and a hand mirror rots the day the field list changes (it
  // gained `classification` the very release this mock was written in;
  // audit 2026-08-16).
  profileInputsSnapshot: jest.requireActual('../../services/enrichmentJob').profileInputsSnapshot,
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const { reenrichAfterRecordEdit } = require('../../services/enrichmentJob');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000c1';
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

const put = (body) => fetch(`${baseUrl}/api/admin/wines/${WINE_ID}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

const mkWine = (over = {}) => {
  const wine = {
    _id: WINE_ID,
    name: 'Douro Tinto', producer: 'Fabelhaft', country: 'c1', region: 'r1',
    appellation: 'Douro', classification: null, type: 'red', grapes: ['g1'],
    aiProfile: { generatedAt: new Date(), source: 'ai' },
    slug: 'douro-tinto',
    ...over,
  };
  wine.save = jest.fn().mockResolvedValue(wine);
  wine.populate = jest.fn().mockResolvedValue(wine);
  return wine;
};

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.distinct.mockResolvedValue([]);
});

test('a real producer change hands the wine to the re-enrich follow-through', async () => {
  const wine = mkWine();
  WineDefinition.findById.mockResolvedValue(wine);

  const res = await put({ name: 'Douro Tinto', producer: 'Niepoort', type: 'red' });
  expect(res.status).toBe(200);
  expect(wine.producer).toBe('Niepoort');
  expect(reenrichAfterRecordEdit).toHaveBeenCalledWith(wine, true);
});

test('the form re-sending every field unchanged does NOT regenerate (the v1.116.0 churn fix)', async () => {
  const wine = mkWine();
  WineDefinition.findById.mockResolvedValue(wine);

  // Exactly what the edit form does on save: full payload, nothing different.
  const res = await put({ name: 'Douro Tinto', producer: 'Fabelhaft', type: 'red', grapes: ['g1'] });
  expect(res.status).toBe(200);
  expect(reenrichAfterRecordEdit).toHaveBeenCalledWith(wine, false);
});

test('a type change alone counts — the profile describes the wrong colour otherwise', async () => {
  const wine = mkWine();
  WineDefinition.findById.mockResolvedValue(wine);

  const res = await put({ name: 'Douro Tinto', producer: 'Fabelhaft', type: 'white' });
  expect(res.status).toBe(200);
  expect(reenrichAfterRecordEdit).toHaveBeenCalledWith(wine, true);
});
