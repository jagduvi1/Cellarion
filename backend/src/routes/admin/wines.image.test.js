/**
 * POST /api/admin/wines and PUT /api/admin/wines/:id — the image field.
 *
 * WHY THIS TEST EXISTS:
 * A wine picture stored inline (a data: URI of up to half a megabyte) rode
 * along in every list, page and copy that showed the wine. From 2026-09-27 a
 * wine record never takes a NEW inline picture: it is a link or one of our
 * uploads (POST /:id/image uploads one). An unchanged inline picture from
 * before still passes, so an unrelated edit of such a wine keeps working until
 * scripts/convert-inline-wine-images.js has converted it.
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
jest.mock('../../models/BottleImage', () => ({ findOne: jest.fn() }));
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
jest.mock('../../models/Country', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: () => ({ catch: () => Promise.resolve({ name: 'Italy' }) }) }) })),
}));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn(async () => ({ wine: null, noMatch: true })) }));
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('../../services/producerSpelling', () => ({ resolveCanonicalProducerSpelling: jest.fn(async (p) => p) }));
jest.mock('../../services/enrichmentJob', () => ({
  profileInputsSnapshot: jest.fn(() => 'same'),
  reenrichAfterRecordEdit: jest.fn(),
}));
jest.mock('../../services/registryFragmentation', () => ({ sameProducerAppellationGroups: jest.fn(), nearProducerPairs: jest.fn() }));
jest.mock('../../services/crossFieldScan', () => ({
  scanCrossFieldChecks: jest.fn(),
  detectCrossFieldForWines: jest.fn(),
  detectBlockingProducerIssue: jest.fn(async () => null),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000b1';
const COUNTRY_ID = '64b0000000000000000000aa';
const INLINE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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

const call = (method, path, body) => fetch(`${baseUrl}/api/admin/wines${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

let wine;
beforeEach(() => {
  jest.clearAllMocks();
  wine = {
    _id: WINE_ID, name: 'Barolo', producer: 'Rossi', type: 'red', image: INLINE, draft: false,
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
  };
  WineDefinition.findById.mockResolvedValue(wine);
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  });
});

describe('PUT /:id', () => {
  test('a new inline picture is refused, nothing saved', async () => {
    wine.image = 'https://cdn.example.com/old.png';
    const res = await call('PUT', `/${WINE_ID}`, { image: INLINE });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be stored inline/);
    expect(wine.save).not.toHaveBeenCalled();
  });

  test('re-sending the unchanged inline picture from before still saves an unrelated edit', async () => {
    const res = await call('PUT', `/${WINE_ID}`, { name: 'Barolo Riserva', image: INLINE });
    expect(res.status).toBe(200);
    expect(wine.save).toHaveBeenCalled();
    expect(wine.name).toBe('Barolo Riserva');
    expect(wine.image).toBe(INLINE);
  });

  test('a link replaces it', async () => {
    const res = await call('PUT', `/${WINE_ID}`, { image: 'https://cdn.example.com/bottle.png' });
    expect(res.status).toBe(200);
    expect(wine.image).toBe('https://cdn.example.com/bottle.png');
  });
});

describe('POST /', () => {
  test('an inline picture is refused, nothing created', async () => {
    const res = await call('POST', '/', { name: 'Barolo', producer: 'Rossi', country: COUNTRY_ID, type: 'red', image: INLINE });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Wine image: .*cannot be stored inline/);
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('one of our uploads is stored as given', async () => {
    const res = await call('POST', '/', { name: 'Barolo', producer: 'Rossi', country: COUNTRY_ID, type: 'red', image: '/api/uploads/processed/abc.webp' });
    expect(res.status).toBe(201);
    expect(WineDefinition.mock.calls[0][0].image).toBe('/api/uploads/processed/abc.webp');
  });
});
