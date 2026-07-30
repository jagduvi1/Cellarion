/**
 * POST/PUT /api/admin/taxonomy/appellations — ref-guard wiring (code audit
 * 2026-07-30: "appellation region not checked against country").
 *
 * The invariant itself is pinned in services/taxonomyReview.refs.test.js;
 * what THIS file pins is that the routes actually call the shared guard and
 * honour its answer — create validates the body's country/region pair, and
 * update re-validates a NEW region against the doc's existing country (update
 * was the easiest drift path: a correctly created doc could be re-pointed at
 * any region). Clearing the region stays guard-free.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  indexWine: jest.fn(),
  removeWine: jest.fn(),
  bulkIndexWines: jest.fn(),
  bulkIndexBottles: jest.fn(),
  fullSync: jest.fn(),
  fullSyncBottles: jest.fn(),
  waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/taxonomyReview', () => ({
  listPendingRegions: jest.fn(),
  listUnmatchedAppellations: jest.fn(),
  appellationRefsError: jest.fn(),
}));
jest.mock('../../models/Appellation', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc);
    this._id = 'ap-1';
    this.save = jest.fn().mockResolvedValue(undefined);
    this.populate = jest.fn().mockResolvedValue(undefined);
  });
  M.findById = jest.fn();
  M.find = jest.fn();
  return M;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { appellationRefsError } = require('../../services/taxonomyReview');
const Appellation = require('../../models/Appellation');
const router = require('./taxonomy');

const ADMIN_ID = '64b000000000000000000001';
const COUNTRY_ID = '64b0000000000000000000c1';
const REGION_ID = '64b0000000000000000000e1';
const AP_ID = '64b0000000000000000000a1';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const call = (method, path, body) => fetch(`${baseUrl}/api/admin/taxonomy${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

beforeEach(() => jest.clearAllMocks());

describe('POST /appellations', () => {
  test('rejects with the guard\'s message and never constructs the doc', async () => {
    appellationRefsError.mockResolvedValue('Region "Rioja" belongs to a different country than the appellation');
    const res = await call('POST', '/appellations', { name: 'Somontano', country: COUNTRY_ID, region: REGION_ID });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/different country/);
    expect(appellationRefsError).toHaveBeenCalledWith(COUNTRY_ID, REGION_ID);
    expect(Appellation).not.toHaveBeenCalled();
  });

  test('creates when the guard passes', async () => {
    appellationRefsError.mockResolvedValue(null);
    const res = await call('POST', '/appellations', { name: 'Somontano', country: COUNTRY_ID, region: REGION_ID });
    expect(res.status).toBe(201);
    expect(Appellation.mock.calls[0][0]).toMatchObject({ country: COUNTRY_ID, region: REGION_ID });
  });
});

describe('PUT /appellations/:id', () => {
  const doc = () => ({
    _id: AP_ID, name: 'Somontano', country: COUNTRY_ID, region: null,
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
  });

  test('setting a region validates it against the DOC\'s country and honours a rejection', async () => {
    const ap = doc();
    Appellation.findById.mockResolvedValue(ap);
    appellationRefsError.mockResolvedValue('Region "Rioja" belongs to a different country than the appellation');
    const res = await call('PUT', `/appellations/${AP_ID}`, { region: REGION_ID });
    expect(res.status).toBe(400);
    // The existing country, not anything from the request body.
    expect(appellationRefsError).toHaveBeenCalledWith(COUNTRY_ID, REGION_ID);
    expect(ap.save).not.toHaveBeenCalled();
    expect(ap.region).toBeNull();
  });

  test('setting a valid region passes and saves', async () => {
    const ap = doc();
    Appellation.findById.mockResolvedValue(ap);
    appellationRefsError.mockResolvedValue(null);
    const res = await call('PUT', `/appellations/${AP_ID}`, { region: REGION_ID });
    expect(res.status).toBe(200);
    expect(ap.region).toBe(REGION_ID);
    expect(ap.save).toHaveBeenCalled();
  });

  test('clearing the region (null) needs no guard — always allowed', async () => {
    const ap = doc();
    ap.region = REGION_ID;
    Appellation.findById.mockResolvedValue(ap);
    const res = await call('PUT', `/appellations/${AP_ID}`, { region: null });
    expect(res.status).toBe(200);
    expect(appellationRefsError).not.toHaveBeenCalled();
    expect(ap.region).toBeNull();
    expect(ap.save).toHaveBeenCalled();
  });
});
