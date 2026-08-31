/**
 * `needsReview` — which user-minted taxonomy rows actually want a decision.
 *
 * WHY (2026-08-31): `pendingReview` is set on EVERY region and grape a user
 * write mints and cleared only by an admin clicking approve, so the queue grows
 * automatically and drains by hand. Measured on production: of 164 regions
 * minted in one month, 161 were in genuine use and exactly one was junk. At a
 * ~1% hit rate the rational response to any row is "approve without looking",
 * which is the same as not reading it — and nobody did, so the real defect in
 * there (one region split across four documents) sat unnoticed. Being flagged
 * never revealed it: all four were flagged, individually.
 *
 * So the screen now asks a better question. Use proves a document real; the
 * one nothing uses is where the junk was. The FLAG ITSELF IS NOT CLEARED —
 * it stays as provenance, and these tests pin that too.
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
jest.mock('../../models/Appellation', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));

const mockRegionFind = jest.fn();
jest.mock('../../models/Region', () => ({
  find: (...a) => mockRegionFind(...a), findById: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(),
}));
const mockGrapeFind = jest.fn();
jest.mock('../../models/Grape', () => ({
  find: (...a) => mockGrapeFind(...a), findById: jest.fn(), exists: jest.fn(),
}));
const mockWineAggregate = jest.fn();
jest.mock('../../models/WineDefinition', () => ({
  aggregate: (...a) => mockWineAggregate(...a), countDocuments: jest.fn(), find: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const router = require('./taxonomy');

const chain = (rows) => ({ select: () => chain(rows), populate: () => chain(rows), sort: () => chain(rows), lean: async () => rows });

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
const get = (path) => fetch(`${baseUrl}/api/admin/taxonomy/${path}`, {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json());

beforeEach(() => {
  jest.clearAllMocks();
  mockWineAggregate.mockResolvedValue([]);
});

describe('regions', () => {
  beforeEach(() => {
    mockRegionFind.mockReturnValue(chain([
      { _id: 'used', name: 'Barolo', pendingReview: true },
      { _id: 'unused', name: 'Wine of Hungary', pendingReview: true },
      { _id: 'curated', name: 'Bordeaux', pendingReview: false },
    ]));
    // wineCountsByRef groups over ALL regions.
    mockWineAggregate.mockResolvedValue([{ _id: 'used', n: 21 }, { _id: 'curated', n: 300 }]);
  });

  test('a user-minted region already in use does NOT need review', async () => {
    const { regions } = await get('regions');
    expect(regions.find((r) => r._id === 'used')).toMatchObject({ wineCount: 21, needsReview: false });
  });

  test('a user-minted region nothing uses DOES need review — where the junk was', async () => {
    const { regions } = await get('regions');
    expect(regions.find((r) => r._id === 'unused')).toMatchObject({ wineCount: 0, needsReview: true });
  });

  test('a curator-created region never needs review, used or not', async () => {
    const { regions } = await get('regions');
    expect(regions.find((r) => r._id === 'curated').needsReview).toBe(false);
  });

  test('the response counts them, so the screen need not be scrolled', async () => {
    expect((await get('regions')).needsReviewCount).toBe(1);
  });

  test('pendingReview is still reported on every row — provenance is not erased', async () => {
    const { regions } = await get('regions');
    expect(regions.find((r) => r._id === 'used').pendingReview).toBe(true);
    expect(regions.find((r) => r._id === 'unused').pendingReview).toBe(true);
  });
});

describe('grapes get the identical rule', () => {
  test('an unused user-minted grape needs review; a used one does not', async () => {
    mockGrapeFind.mockReturnValue(chain([
      { _id: 'g1', name: 'Malvoisie', pendingReview: true },
      { _id: 'g2', name: 'Nonsensegrape', pendingReview: true },
    ]));
    mockWineAggregate.mockResolvedValue([{ _id: 'g1', n: 4 }]);
    const body = await get('grapes');
    expect(body.grapes.find((g) => g._id === 'g1')).toMatchObject({ wineCount: 4, needsReview: false });
    expect(body.grapes.find((g) => g._id === 'g2')).toMatchObject({ wineCount: 0, needsReview: true });
    expect(body.needsReviewCount).toBe(1);
  });
});
