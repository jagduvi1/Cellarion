/**
 * POST / DELETE /api/admin/wines/dismiss-duplicates — an admin's verdict that
 * the wines of a duplicate cluster are NOT the same wine, and its undo.
 *
 * The verdict is stored per pair (models/WineNotDuplicate), so the duplicate
 * scans stop surfacing those wines together. This suite pins the contract:
 *   - at least two valid, distinct ids, checked before any write
 *   - every unordered pair of the cluster is recorded once, the smaller id
 *     first, whatever order the client sent them in
 *   - the write is an upsert (recording a pair twice is harmless), the undo
 *     deletes exactly those pairs
 *   - an audit row either way, and admins only
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
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/BottleImage', () => ({}));
jest.mock('../../models/WineVintageProfile', () => ({}));
jest.mock('../../models/WineVintagePrice', () => ({}));
jest.mock('../../models/WineReport', () => ({}));
jest.mock('../../models/Review', () => ({}));
jest.mock('../../models/Discussion', () => ({}));
jest.mock('../../models/DiscussionReply', () => ({}));
jest.mock('../../models/WineEmbedding', () => ({}));
jest.mock('../../models/WineNotDuplicate', () => ({ find: jest.fn(), bulkWrite: jest.fn(), deleteMany: jest.fn() }));
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
const WineNotDuplicate = require('../../models/WineNotDuplicate');
const { logAudit } = require('../../services/audit');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_A = '64b0000000000000000000a1';
const WINE_B = '64b0000000000000000000b2';
const WINE_C = '64b0000000000000000000c3';
const token = (roles) => jwt.sign({ id: ADMIN_ID, roles }, 'test-secret');

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
  WineNotDuplicate.bulkWrite.mockResolvedValue({ upsertedCount: 3 });
  WineNotDuplicate.deleteMany.mockResolvedValue({ deletedCount: 3 });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const call = (method, body, roles = ['admin']) => fetch(`${baseUrl}/api/admin/wines/dismiss-duplicates`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(roles)}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// A pair as the route hands it to the model, with the ids as strings.
const asStrings = (pair) => ({ wineA: String(pair.wineA), wineB: String(pair.wineB) });
const ALL_PAIRS = [
  { wineA: WINE_A, wineB: WINE_B },
  { wineA: WINE_A, wineB: WINE_C },
  { wineA: WINE_B, wineB: WINE_C },
];

describe('POST /dismiss-duplicates', () => {
  test('records every pair of the cluster once, as an upsert', async () => {
    const res = await call('POST', { wineIds: [WINE_A, WINE_B, WINE_C] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Marked as not duplicates', pairsRecorded: 3 });

    const [ops, options] = WineNotDuplicate.bulkWrite.mock.calls[0];
    expect(options).toEqual({ ordered: false });
    expect(ops.map((op) => asStrings(op.updateOne.filter))).toEqual(ALL_PAIRS);
    for (const op of ops) {
      expect(op.updateOne.upsert).toBe(true);
      expect(asStrings(op.updateOne.update.$setOnInsert)).toEqual(asStrings(op.updateOne.filter));
    }
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.dismissDuplicates', { type: 'wine', id: WINE_A },
      { wineIds: [WINE_A, WINE_B, WINE_C], pairs: 3 },
    );
  });

  test('a pair is stored smaller id first, whatever order it was sent in', async () => {
    await call('POST', { wineIds: [WINE_C, WINE_A] });

    const [ops] = WineNotDuplicate.bulkWrite.mock.calls[0];
    expect(ops.map((op) => asStrings(op.updateOne.filter))).toEqual([{ wineA: WINE_A, wineB: WINE_C }]);
  });

  test('repeated and invalid ids are dropped before the pairs are built', async () => {
    const res = await call('POST', { wineIds: [WINE_A, WINE_A, 'not-an-id', { $gt: '' }, WINE_B] });

    expect(res.status).toBe(200);
    expect((await res.json()).pairsRecorded).toBe(1);
  });

  test.each([
    ['no body', undefined],
    ['one id', { wineIds: [WINE_A] }],
    ['the same id twice', { wineIds: [WINE_A, WINE_A] }],
    ['an operator in place of the list', { wineIds: { $gt: '' } }],
    ['only invalid ids', { wineIds: ['x', 'y'] }],
  ])('refuses %s with 400 and writes nothing', async (_label, body) => {
    const res = await call('POST', body);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('wineIds must contain at least 2 valid, distinct ids');
    expect(WineNotDuplicate.bulkWrite).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('answers 500 when the write fails, and records no audit row', async () => {
    WineNotDuplicate.bulkWrite.mockRejectedValue(new Error('db down'));
    const res = await call('POST', { wineIds: [WINE_A, WINE_B] });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to mark as not duplicates');
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('is for admins only', async () => {
    const res = await call('POST', { wineIds: [WINE_A, WINE_B] }, ['user']);

    expect(res.status).toBe(403);
    expect(WineNotDuplicate.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('DELETE /dismiss-duplicates', () => {
  test('removes exactly the pairs of the cluster', async () => {
    const res = await call('DELETE', { wineIds: [WINE_C, WINE_B, WINE_A] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Restored', pairsRemoved: 3 });

    const [filter] = WineNotDuplicate.deleteMany.mock.calls[0];
    expect(filter.$or.map(asStrings).sort((x, y) => (x.wineA + x.wineB).localeCompare(y.wineA + y.wineB))).toEqual(ALL_PAIRS);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.undismissDuplicates', { type: 'wine', id: WINE_C },
      { wineIds: [WINE_C, WINE_B, WINE_A] },
    );
  });

  test('reports 0 when no such pair was stored', async () => {
    WineNotDuplicate.deleteMany.mockResolvedValue({});
    const res = await call('DELETE', { wineIds: [WINE_A, WINE_B] });

    expect(await res.json()).toEqual({ message: 'Restored', pairsRemoved: 0 });
  });

  test('refuses fewer than two valid ids with 400 and deletes nothing', async () => {
    const res = await call('DELETE', { wineIds: [WINE_A, 'nope'] });

    expect(res.status).toBe(400);
    expect(WineNotDuplicate.deleteMany).not.toHaveBeenCalled();
  });

  test('answers 500 when the delete fails', async () => {
    WineNotDuplicate.deleteMany.mockRejectedValue(new Error('db down'));
    const res = await call('DELETE', { wineIds: [WINE_A, WINE_B] });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to restore');
  });

  test('is for admins only', async () => {
    const res = await call('DELETE', { wineIds: [WINE_A, WINE_B] }, ['user']);

    expect(res.status).toBe(403);
    expect(WineNotDuplicate.deleteMany).not.toHaveBeenCalled();
  });
});
