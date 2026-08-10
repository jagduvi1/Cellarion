/**
 * GET /api/admin/wines/cross-field-checks + POST/DELETE /cross-checks-clear —
 * the cross-field domain queue (ticket analysis 2026-08-10, Tier-2 item 5).
 * The detection lives in services/crossFieldScan (unit-tested there); this
 * suite pins the route contract:
 *   - the producer-in-name-style pagination envelope, ?check= validation and
 *     the includeCleared audit switch. The happy path returning 200 also pins
 *     ROUTE PLACEMENT: were the route declared after GET /:id, the literal
 *     path segment would fall into the id param and 400 as an invalid id.
 *   - clearance writes: server-side re-detect (a stale client row cannot
 *     clear a rule the admin never saw), $addToSet to crossChecksCleared —
 *     NEVER verifiedChecks, the families' stores stay disjoint — audit-log
 *     calls, and no search re-index / no IndexNow (a clearance is not public
 *     content). Operator-injection rejection BEFORE any query (house rule).
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
jest.mock('../../services/registryFragmentation', () => ({
  sameProducerAppellationGroups: jest.fn(),
  nearProducerPairs: jest.fn(),
}));
jest.mock('../../services/crossFieldScan', () => ({
  scanCrossFieldChecks: jest.fn(),
  detectCrossFieldForWines: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const { scanCrossFieldChecks, detectCrossFieldForWines } = require('../../services/crossFieldScan');
const {
  CROSS_FIELD_CHECK_IDS, DEFAULT_CROSS_FIELD_CHECK_IDS,
} = require('../../utils/crossFieldChecks');
const adminWinesRouter = require('./wines');

const ADMIN_ID = '64b000000000000000000001';
const WINE_A = '64b0000000000000000000b1';
const WINE_B = '64b0000000000000000000b2';
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

const emptyScan = () => ({ rows: [], ruleCounts: {}, total: 0, clearedCount: 0, scannedCount: 0 });

beforeEach(() => {
  jest.clearAllMocks();
  scanCrossFieldChecks.mockResolvedValue(emptyScan());
  detectCrossFieldForWines.mockResolvedValue(new Map());
  WineDefinition.bulkWrite.mockResolvedValue({ modifiedCount: 1 });
  WineDefinition.updateMany.mockResolvedValue({ modifiedCount: 1 });
});

const get = (qs = '', headers = { Authorization: `Bearer ${adminToken()}` }) =>
  fetch(`${baseUrl}/api/admin/wines/cross-field-checks${qs}`, { headers });

const call = (method, path, body) => fetch(`${baseUrl}/api/admin/wines${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const ROW = {
  wine: { _id: WINE_A, name: 'Sec', producer: 'Monbazillac', appellation: null, region: null, country: 'France' },
  hits: [{ check: 'producer-is-appellation.v1', detail: 'Monbazillac' }],
  cleared: [],
};

describe('GET /cross-field-checks', () => {
  test('paginated envelope around the service result, defaults to every defaultActive rule', async () => {
    scanCrossFieldChecks.mockResolvedValue({
      rows: [ROW], ruleCounts: { 'producer-is-appellation.v1': 1 },
      total: 1, clearedCount: 2, scannedCount: 5500,
    });

    const res = await get();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.wines).toEqual([{ ...ROW.wine, hits: ROW.hits, cleared: [] }]);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(data.pages).toBe(1);
    expect(data.clearedCount).toBe(2);
    expect(data.scannedCount).toBe(5500);
    expect(data.ruleCounts).toEqual({ 'producer-is-appellation.v1': 1 });
    expect(data.checkIds).toEqual(DEFAULT_CROSS_FIELD_CHECK_IDS);
    expect(data.allCheckIds).toEqual(CROSS_FIELD_CHECK_IDS);
    expect(data.checkLabelKeys['producer-is-appellation.v1']).toBe('producerIsAppellation');
    expect(data.checkFields['producer-is-appellation.v1']).toBe('producer');
    expect(scanCrossFieldChecks).toHaveBeenCalledWith({
      checkIds: DEFAULT_CROSS_FIELD_CHECK_IDS, ignoreCleared: false,
    });
  });

  test('pagination slices the service rows at the route layer', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      wine: { _id: `w${i}` }, hits: ROW.hits, cleared: [],
    }));
    scanCrossFieldChecks.mockResolvedValue({ rows, ruleCounts: {}, total: 5, clearedCount: 0, scannedCount: 5 });

    const data = await (await get('?limit=2&page=2')).json();
    expect(data.wines.map(w => w._id)).toEqual(['w2', 'w3']);
    expect(data.pages).toBe(3);
  });

  test('?check= scopes to one rule; ?includeCleared=1 is the audit view', async () => {
    await get('?check=region-is-country.v1&includeCleared=1');
    expect(scanCrossFieldChecks).toHaveBeenCalledWith({
      checkIds: ['region-is-country.v1'], ignoreCleared: true,
    });
  });

  test('?check=bogus → 400 and no scan runs (operator shapes included)', async () => {
    expect((await get('?check=bogus.v9')).status).toBe(400);
    expect((await get('?check[$gt]=')).status).toBe(400);
    expect(scanCrossFieldChecks).not.toHaveBeenCalled();
  });

  test('requires auth (the router-level admin gate covers the new paths)', async () => {
    const res = await get('', {});
    expect(res.status).toBe(401);
    expect(scanCrossFieldChecks).not.toHaveBeenCalled();
  });
});

describe('POST /cross-checks-clear', () => {
  test('re-detects server-side, records with $addToSet + clearedAt, audits, never re-indexes', async () => {
    detectCrossFieldForWines.mockResolvedValue(new Map([[WINE_A, ['producer-is-appellation.v1']]]));

    const res = await call('POST', '/cross-checks-clear', {
      wineIds: [WINE_A], checks: ['producer-is-appellation.v1'],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.updated).toBe(1);
    expect(data.notFlagged).toEqual([]);

    const [ids, checkIds] = detectCrossFieldForWines.mock.calls[0];
    expect(ids.map(String)).toEqual([WINE_A]);
    expect(checkIds).toEqual(['producer-is-appellation.v1']);

    const ops = WineDefinition.bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.update.$addToSet).toEqual({
      crossChecksCleared: { $each: ['producer-is-appellation.v1'] },
    });
    expect(ops[0].updateOne.update.$set.crossChecksClearedAt).toBeInstanceOf(Date);
    // The families' stores stay disjoint — never the nameChecks field.
    expect(JSON.stringify(ops)).not.toContain('verifiedChecks');

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.clearCrossChecks',
      { type: 'wine', id: WINE_A },
      expect.objectContaining({ checks: ['producer-is-appellation.v1'], updated: 1 })
    );
    expect(searchService.indexWine).not.toHaveBeenCalled();
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('server-side re-detect: a wine that does not trip the named rule is notFlagged, nothing written', async () => {
    detectCrossFieldForWines.mockResolvedValue(new Map([[WINE_A, []]]));

    const res = await call('POST', '/cross-checks-clear', {
      wineIds: [WINE_A], checks: ['producer-is-appellation.v1'],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.updated).toBe(0);
    expect(data.notFlagged).toEqual([WINE_A]);
    expect(WineDefinition.bulkWrite).not.toHaveBeenCalled();
  });

  test.each([
    ['missing checks', { wineIds: [WINE_A] }],
    ['empty checks', { wineIds: [WINE_A], checks: [] }],
    ['unknown check id', { wineIds: [WINE_A], checks: ['bogus.v9'] }],
    ['a nameChecks id (wrong family)', { wineIds: [WINE_A], checks: ['name-equals-producer.v1'] }],
    ['operator-injection in checks', { wineIds: [WINE_A], checks: [{ $gt: '' }] }],
    ['operator-injection in wineIds', { wineIds: [{ $gt: '' }], checks: ['producer-is-appellation.v1'] }],
    ['no valid wineIds', { wineIds: [], checks: ['producer-is-appellation.v1'] }],
  ])('%s → 400, nothing queried', async (_label, body) => {
    const res = await call('POST', '/cross-checks-clear', body);
    expect(res.status).toBe(400);
    expect(detectCrossFieldForWines).not.toHaveBeenCalled();
    expect(WineDefinition.bulkWrite).not.toHaveBeenCalled();
  });

  test('more than 500 wineIds → 400', async () => {
    const ids = Array.from({ length: 501 }, (_, i) =>
      `64b00000000000000000${String(1000 + i).slice(1)}`);
    const res = await call('POST', '/cross-checks-clear', { wineIds: ids, checks: ['producer-is-appellation.v1'] });
    expect(res.status).toBe(400);
    expect(detectCrossFieldForWines).not.toHaveBeenCalled();
  });

  test('unknown wine ids → 404', async () => {
    detectCrossFieldForWines.mockResolvedValue(new Map());
    const res = await call('POST', '/cross-checks-clear', {
      wineIds: [WINE_A], checks: ['producer-is-appellation.v1'],
    });
    expect(res.status).toBe(404);
  });

  test('multi-wine call: found-but-clean and flagged wines are handled per row', async () => {
    detectCrossFieldForWines.mockResolvedValue(new Map([
      [WINE_A, ['producer-is-appellation.v1']],
      [WINE_B, []],
    ]));
    WineDefinition.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

    const data = await (await call('POST', '/cross-checks-clear', {
      wineIds: [WINE_A, WINE_B], checks: ['producer-is-appellation.v1'],
    })).json();
    expect(data.updated).toBe(1);
    expect(data.notFlagged).toEqual([WINE_B]);
    expect(WineDefinition.bulkWrite.mock.calls[0][0]).toHaveLength(1);
  });
});

describe('DELETE /cross-checks-clear', () => {
  test('pulls the rule ids from crossChecksCleared and audits the undo', async () => {
    const res = await call('DELETE', '/cross-checks-clear', {
      wineIds: [WINE_A], checks: ['producer-is-appellation.v1'],
    });
    expect(res.status).toBe(200);

    const [filter, update] = WineDefinition.updateMany.mock.calls[0];
    expect(filter._id.$in.map(String)).toEqual([WINE_A]);
    expect(update).toEqual({ $pull: { crossChecksCleared: { $in: ['producer-is-appellation.v1'] } } });

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.wine.unclearCrossChecks',
      { type: 'wine', id: WINE_A },
      expect.objectContaining({ checks: ['producer-is-appellation.v1'] })
    );
  });

  test('bad checks → 400, nothing updated', async () => {
    const res = await call('DELETE', '/cross-checks-clear', { wineIds: [WINE_A], checks: ['nope'] });
    expect(res.status).toBe(400);
    expect(WineDefinition.updateMany).not.toHaveBeenCalled();
  });
});
