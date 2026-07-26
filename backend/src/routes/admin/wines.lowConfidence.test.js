/**
 * GET /api/admin/wines/low-confidence + the profile-reviewed toggle — the
 * "model in doubt" queue. Pins: the outstanding filter's self-invalidating
 * comparison (reviewedAt vs generatedAt — NOT a boolean), threshold clamping
 * against junk input, and the audited mark/unmark round-trip.
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

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const { logAudit } = require('../../services/audit');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000d1';
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

const listChain = (rows) => {
  const chain = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.populate = jest.fn().mockReturnValue(chain);
  chain.sort = jest.fn().mockReturnValue(chain);
  chain.skip = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.lean = jest.fn().mockResolvedValue(rows);
  return chain;
};

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.find.mockReturnValue(listChain([]));
  WineDefinition.countDocuments.mockResolvedValue(0);
  WineDefinition.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  Bottle.aggregate.mockResolvedValue([]);
});

const get = (qs = '') => fetch(`${baseUrl}/api/admin/wines/low-confidence${qs}`, {
  headers: { Authorization: `Bearer ${adminToken()}` },
});

describe('GET /low-confidence', () => {
  test('default threshold 0.3, outstanding filter compares reviewedAt against generatedAt', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).threshold).toBe(0.3);

    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter.nonWine).toEqual({ $ne: true });
    expect(filter['aiProfile.confidence']).toEqual({ $ne: null, $lte: 0.3 });
    // The self-invalidation contract: suppression is a COMPARISON, so a
    // re-enriched profile (new generatedAt) re-surfaces the row with no hook.
    expect(filter.$expr).toEqual({
      $or: [
        { $eq: ['$profileReviewedAt', null] },
        { $lt: ['$profileReviewedAt', '$aiProfile.generatedAt'] },
      ],
    });
  });

  test('threshold is clamped and junk falls back to the default', async () => {
    expect((await (await get('?threshold=0.4')).json()).threshold).toBe(0.4);
    expect((await (await get('?threshold=7')).json()).threshold).toBe(1);
    expect((await (await get('?threshold=-2')).json()).threshold).toBe(0);
    expect((await (await get('?threshold=abc')).json()).threshold).toBe(0.3);
    expect((await (await get('?threshold[$gt]=')).json()).threshold).toBe(0.3);
  });

  test('?includeReviewed=1 drops the comparison clause (audit view)', async () => {
    await get('?includeReviewed=1');
    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter.$expr).toBeUndefined();
    expect(filter['aiProfile.confidence']).toEqual({ $ne: null, $lte: 0.3 });
  });

  test('rows carry the model doubt fields and bottle counts', async () => {
    WineDefinition.find.mockReturnValue(listChain([{
      _id: WINE_ID, name: 'Le Valet d’Épée', producer: 'Arcane',
      aiProfile: { confidence: 0.2, description: 'hedge', producerSuspect: true, producerNote: 'Arcane is a range of Xavier Vignon', generatedAt: new Date('2026-07-26T08:57:24Z') },
      profileReviewedAt: null,
    }]));
    Bottle.aggregate.mockResolvedValue([{ _id: WINE_ID, count: 8 }]);

    const data = await (await get()).json();
    expect(data.wines[0]).toMatchObject({
      producer: 'Arcane', confidence: 0.2, producerSuspect: true,
      producerNote: 'Arcane is a range of Xavier Vignon', bottleCount: 8,
    });
  });
});

describe('profile-reviewed toggle', () => {
  test('POST records the review with the current time and audits', async () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: WINE_ID, name: 'Le Valet d’Épée', producer: 'Arcane' }),
    });

    const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.status).toBe(200);

    const [q, update] = WineDefinition.updateOne.mock.calls[0];
    expect(String(q._id)).toBe(WINE_ID);
    expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.profileReviewed',
      { type: 'wine', id: WINE_ID },
      expect.objectContaining({ producer: 'Arcane' })
    );
  });

  test('DELETE nulls the review and audits the undo', async () => {
    const res = await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.status).toBe(200);
    expect(WineDefinition.updateOne).toHaveBeenCalledWith(
      { _id: WINE_ID }, { $set: { profileReviewedAt: null } });
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.profileUnreviewed',
      { type: 'wine', id: WINE_ID }, {});
  });

  test('invalid id → 400; unknown id → 404 on both verbs', async () => {
    expect((await fetch(`${baseUrl}/api/admin/wines/nope/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    })).status).toBe(400);

    WineDefinition.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    expect((await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken()}` },
    })).status).toBe(404);

    WineDefinition.updateOne.mockResolvedValue({ matchedCount: 0 });
    expect((await fetch(`${baseUrl}/api/admin/wines/${WINE_ID}/profile-reviewed`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${adminToken()}` },
    })).status).toBe(404);
  });
});
