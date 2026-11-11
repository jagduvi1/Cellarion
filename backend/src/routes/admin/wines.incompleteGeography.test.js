/**
 * GET /api/admin/wines/incomplete-geography and POST / DELETE
 * /incomplete-geography/clear — the completeness queue: wines that are not
 * wrong, only blank where a region belongs.
 *
 * The scan lives in services/registryCompleteness; this suite pins the route
 * contract:
 *   - the paging envelope around the service's answer, and the includeCleared
 *     switch. The 200 also pins ROUTE PLACEMENT: declared after GET /:id, the
 *     literal segment would be read as an id and answer 400.
 *   - a clearance is recorded only for wines the server still finds
 *     incomplete (a stale client row cannot clear a wine that has since been
 *     filled in), as the completeness check id in crossChecksCleared, with an
 *     audit row, and without re-indexing: a clearance is not public content.
 *   - the undo pulls that id and nothing else.
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
jest.mock('../../services/registryCompleteness', () => ({
  incompleteGeographyRows: jest.fn(),
  stillIncomplete: jest.fn(),
  GEOGRAPHY_INCOMPLETE_CHECK_ID: 'geography-incomplete.v1',
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const {
  incompleteGeographyRows, stillIncomplete, GEOGRAPHY_INCOMPLETE_CHECK_ID,
} = require('../../services/registryCompleteness');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_A = '64b0000000000000000000a1';
const WINE_B = '64b0000000000000000000b2';
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
  incompleteGeographyRows.mockResolvedValue({ rows: [], total: 0, scannedCount: 0, clearedCount: 0 });
  stillIncomplete.mockResolvedValue(new Set());
  WineDefinition.updateMany.mockResolvedValue({ modifiedCount: 1 });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const call = (method, path, body, roles = ['admin']) => fetch(`${baseUrl}/api/admin/wines${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(roles)}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const noReindex = () => {
  expect(searchService.indexWine).not.toHaveBeenCalled();
  expect(submitUrls).not.toHaveBeenCalled();
};

describe('GET /incomplete-geography', () => {
  test('wraps the scan in the paging envelope, 50 rows a page by default', async () => {
    const rows = [{ _id: WINE_A, name: 'Brut', producer: 'Example Estate', bottleCount: 4 }];
    incompleteGeographyRows.mockResolvedValue({ rows, total: 120, scannedCount: 5400, clearedCount: 7 });

    const res = await call('GET', '/incomplete-geography');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows, total: 120, page: 1, pages: 3, scannedCount: 5400, clearedCount: 7 });
    expect(incompleteGeographyRows).toHaveBeenCalledWith({ limit: 50, offset: 0, includeCleared: false });
  });

  test('passes the page on as an offset and caps the page size at 200', async () => {
    await call('GET', '/incomplete-geography?page=3&limit=20');
    expect(incompleteGeographyRows).toHaveBeenLastCalledWith({ limit: 20, offset: 40, includeCleared: false });

    await call('GET', '/incomplete-geography?limit=5000');
    expect(incompleteGeographyRows).toHaveBeenLastCalledWith({ limit: 200, offset: 0, includeCleared: false });
  });

  test.each(['1', 'true'])('includeCleared=%s asks for the cleared rows too', async (flag) => {
    await call('GET', `/incomplete-geography?includeCleared=${flag}`);
    expect(incompleteGeographyRows).toHaveBeenCalledWith({ limit: 50, offset: 0, includeCleared: true });
  });

  test('answers 500 when the scan fails', async () => {
    incompleteGeographyRows.mockRejectedValue(new Error('db down'));
    const res = await call('GET', '/incomplete-geography');

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to scan for incomplete geography');
  });

  test('is for admins only', async () => {
    const res = await call('GET', '/incomplete-geography', undefined, ['user']);

    expect(res.status).toBe(403);
    expect(incompleteGeographyRows).not.toHaveBeenCalled();
  });
});

describe('POST /incomplete-geography/clear', () => {
  test('records the clearance on the wines the server still finds incomplete, and only on those', async () => {
    stillIncomplete.mockResolvedValue(new Set([WINE_A]));
    const res = await call('POST', '/incomplete-geography/clear', { wineIds: [WINE_A, WINE_B] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Recorded', updated: 1, notFlagged: 1 });
    expect(stillIncomplete.mock.calls[0][0].map(String)).toEqual([WINE_A, WINE_B]);

    const [filter, update] = WineDefinition.updateMany.mock.calls[0];
    expect(filter._id.$in.map(String)).toEqual([WINE_A]);
    expect(update.$addToSet).toEqual({ crossChecksCleared: GEOGRAPHY_INCOMPLETE_CHECK_ID });
    expect(update.$set.crossChecksClearedAt).toBeInstanceOf(Date);
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.clearIncompleteGeography', { type: 'wine', id: WINE_A },
      { wineIds: [WINE_A, WINE_B], updated: 1, notFlagged: 1 },
    );
    noReindex();
  });

  test('answers 404 and writes nothing when none of the wines is incomplete any more', async () => {
    const res = await call('POST', '/incomplete-geography/clear', { wineIds: [WINE_A] });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No matching wines');
    expect(WineDefinition.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test.each([
    ['no body', undefined],
    ['an empty list', { wineIds: [] }],
    ['an operator in place of the list', { wineIds: { $ne: null } }],
    ['only invalid ids', { wineIds: ['x', { $gt: '' }] }],
  ])('refuses %s with 400 before any query', async (_label, body) => {
    const res = await call('POST', '/incomplete-geography/clear', body);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('wineIds must contain at least 1 valid id');
    expect(stillIncomplete).not.toHaveBeenCalled();
    expect(WineDefinition.updateMany).not.toHaveBeenCalled();
  });

  test('refuses more than 500 ids in one call', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `64b0000000000000000${String(i).padStart(5, '0')}`);
    const res = await call('POST', '/incomplete-geography/clear', { wineIds: many });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('At most 500 wineIds per call');
    expect(stillIncomplete).not.toHaveBeenCalled();
  });

  test('answers 500 when the write fails', async () => {
    stillIncomplete.mockResolvedValue(new Set([WINE_A]));
    WineDefinition.updateMany.mockRejectedValue(new Error('db down'));
    const res = await call('POST', '/incomplete-geography/clear', { wineIds: [WINE_A] });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to record the clearance');
  });

  test('is for admins only', async () => {
    const res = await call('POST', '/incomplete-geography/clear', { wineIds: [WINE_A] }, ['user']);

    expect(res.status).toBe(403);
    expect(stillIncomplete).not.toHaveBeenCalled();
  });
});

describe('DELETE /incomplete-geography/clear', () => {
  test('pulls the completeness clearance from the wines, and nothing else', async () => {
    WineDefinition.updateMany.mockResolvedValue({ modifiedCount: 2 });
    const res = await call('DELETE', '/incomplete-geography/clear', { wineIds: [WINE_A, WINE_B, WINE_A] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Cleared', updated: 2 });

    const [filter, update] = WineDefinition.updateMany.mock.calls[0];
    expect(filter._id.$in.map(String)).toEqual([WINE_A, WINE_B]);
    expect(update).toEqual({ $pull: { crossChecksCleared: GEOGRAPHY_INCOMPLETE_CHECK_ID } });
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.unclearIncompleteGeography', { type: 'wine', id: WINE_A },
      { wineIds: [WINE_A, WINE_B], updated: 2 },
    );
    noReindex();
  });

  test('refuses an empty or oversized list with 400', async () => {
    expect((await call('DELETE', '/incomplete-geography/clear', { wineIds: ['x'] })).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => `64b0000000000000000${String(i).padStart(5, '0')}`);
    expect((await call('DELETE', '/incomplete-geography/clear', { wineIds: many })).status).toBe(400);
    expect(WineDefinition.updateMany).not.toHaveBeenCalled();
  });

  test('answers 500 when the write fails', async () => {
    WineDefinition.updateMany.mockRejectedValue(new Error('db down'));
    const res = await call('DELETE', '/incomplete-geography/clear', { wineIds: [WINE_A] });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to undo the clearance');
  });

  test('is for admins only', async () => {
    const res = await call('DELETE', '/incomplete-geography/clear', { wineIds: [WINE_A] }, ['user']);

    expect(res.status).toBe(403);
    expect(WineDefinition.updateMany).not.toHaveBeenCalled();
  });
});
