/**
 * GET /api/admin/taxonomy/regions/duplicate-candidates
 *
 * The scan that would have caught the Loire split (four documents, 208 wines,
 * 2026-08-31) the day it started rather than six weeks later.
 *
 * The signature rule itself is tested in utils/taxonomyDuplicates.test.js.
 * These pin the wiring an admin depends on: that clusters never cross a
 * country, that the suggested merge target is the document holding the most
 * wines, and that wine counts come from one grouped query rather than a
 * per-member fan-out.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false), fullSync: jest.fn(), fullSyncBottles: jest.fn(),
  indexWine: jest.fn(), removeWine: jest.fn(), bulkIndexWines: jest.fn(),
  bulkIndexBottles: jest.fn(), waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/taxonomyMerge', () => ({ mergeGrapes: jest.fn(), mergeRegions: jest.fn(), mergeCountries: jest.fn() }));
jest.mock('../../services/taxonomyReview', () => ({
  listUnmatchedAppellations: jest.fn(), appellationRefsError: jest.fn(),
  dismissUnmatchedAppellation: jest.fn(), restoreDismissedAppellation: jest.fn(),
  listDismissedAppellations: jest.fn(),
}));
jest.mock('../../services/bottleSizeMaintenance', () => ({ distinctSizes: jest.fn(), normalizeAll: jest.fn(), remap: jest.fn() }));
jest.mock('../taxonomy', () => ({ clearTaxonomyListCache: jest.fn() }));
jest.mock('../../models/Country', () => ({ find: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock('../../models/Grape', () => ({ find: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock('../../models/Appellation', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));

const mockRegionFind = jest.fn();
jest.mock('../../models/Region', () => ({
  find: (...a) => mockRegionFind(...a), findById: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(),
}));
const mockWineAggregate = jest.fn();
jest.mock('../../models/WineDefinition', () => ({
  aggregate: (...a) => mockWineAggregate(...a), countDocuments: jest.fn(), find: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const router = require('./taxonomy');

const FR = { _id: 'fr', name: 'France' };
const IT = { _id: 'it', name: 'Italy' };

const chain = (rows) => ({ select: () => chain(rows), populate: () => chain(rows), lean: async () => rows });

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const token = jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret');
const scan = () => fetch(`${baseUrl}/api/admin/taxonomy/regions/duplicate-candidates`, {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json());

beforeEach(() => {
  jest.clearAllMocks();
  mockWineAggregate.mockResolvedValue([]);
});

describe('the Loire cluster', () => {
  beforeEach(() => {
    mockRegionFind.mockReturnValue(chain([
      { _id: 'r1', name: 'Loire Valley', country: FR, pendingReview: false, synonyms: [] },
      { _id: 'r2', name: 'Vallée de la Loire', country: FR, pendingReview: true, synonyms: [] },
      { _id: 'r3', name: 'Val de Loire', country: FR, pendingReview: true, synonyms: [] },
      { _id: 'r4', name: 'Barolo', country: IT, pendingReview: false, synonyms: [] },
    ]));
    mockWineAggregate.mockResolvedValue([
      { _id: 'r1', n: 173 }, { _id: 'r2', n: 32 }, { _id: 'r3', n: 1 },
    ]);
  });

  test('finds the three Loire spellings and leaves Barolo alone', async () => {
    const body = await scan();
    expect(body.clusters).toHaveLength(1);
    expect(body.clusters[0].members.map((m) => m._id)).toEqual(['r1', 'r2', 'r3']);
    expect(body.scannedCount).toBe(4);
  });

  test('suggests the biggest document as the merge target, not the newest', async () => {
    const [cluster] = (await scan()).clusters;
    expect(cluster.suggestedTargetId).toBe('r1');
    expect(cluster.members[0].wineCount).toBe(173);
    expect(cluster.totalWines).toBe(206);
    expect(cluster.country).toBe('France');
  });

  test('wine counts come from ONE grouped query, not one per member', async () => {
    await scan();
    expect(mockWineAggregate).toHaveBeenCalledTimes(1);
  });
});

describe('safety', () => {
  test('the same name under two countries is never one cluster', async () => {
    mockRegionFind.mockReturnValue(chain([
      { _id: 'a', name: 'Georgia', country: { _id: 'us', name: 'United States' } },
      { _id: 'b', name: 'Georgia', country: { _id: 'ge', name: 'Georgia' } },
    ]));
    expect((await scan()).clusters).toHaveLength(0);
  });

  test('distinct appellations that merely share a word are not proposed', async () => {
    mockRegionFind.mockReturnValue(chain([
      { _id: 'a', name: 'Médoc', country: FR },
      { _id: 'b', name: 'Haut-Médoc', country: FR },
      { _id: 'c', name: 'Pomerol', country: FR },
      { _id: 'd', name: 'Lalande-de-Pomerol', country: FR },
    ]));
    expect((await scan()).clusters).toHaveLength(0);
  });

  test('a clean taxonomy returns an empty list with the count it scanned', async () => {
    mockRegionFind.mockReturnValue(chain([{ _id: 'a', name: 'Barolo', country: IT }]));
    const body = await scan();
    expect(body.clusters).toEqual([]);
    expect(body.scannedCount).toBe(1);
  });

  test('a member with no wines still appears, ranked last', async () => {
    mockRegionFind.mockReturnValue(chain([
      { _id: 'a', name: 'Rioja', country: { _id: 'es', name: 'Spain' } },
      { _id: 'b', name: 'La Rioja', country: { _id: 'es', name: 'Spain' } },
    ]));
    mockWineAggregate.mockResolvedValue([{ _id: 'a', n: 12 }]);
    const [cluster] = (await scan()).clusters;
    expect(cluster.members.map((m) => m.wineCount)).toEqual([12, 0]);
    expect(cluster.suggestedTargetId).toBe('a');
  });
});
