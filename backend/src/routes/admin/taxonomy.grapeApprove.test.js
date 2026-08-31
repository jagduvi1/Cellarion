/**
 * POST /api/admin/taxonomy/grapes/:id/approve — the review verb for
 * user-minted grapes (somm ticket 6a942a60: bottle-add/import wrote "Honey"
 * and "Alvarão" straight into the shared taxonomy with no gate).
 *
 * Pins the three properties the regions verb established: approval is an
 * explicit act (flag flips, audit written), it is idempotent (a second click
 * neither saves nor audits again), and bad ids answer 400/404 rather than
 * 500.
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
jest.mock('../../models/Country', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../../models/Region', () => ({ findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ countDocuments: jest.fn() }));
jest.mock('../../models/Grape', () => {
  const Grape = jest.fn(function (fields) {
    Object.assign(this, fields);
    this.save = jest.fn().mockResolvedValue(undefined);
  });
  Grape.findById = jest.fn();
  Grape.find = jest.fn();
  Grape.exists = jest.fn();
  return Grape;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Grape = require('../../models/Grape');
const { logAudit } = require('../../services/audit');
const router = require('./taxonomy');

const ADMIN_ID = '64b000000000000000000001';
const GRAPE_ID = '64b00000000000000000009e';

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

const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');
const approve = (id) => fetch(`${baseUrl}/api/admin/taxonomy/grapes/${id}/approve`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
});

beforeEach(() => jest.clearAllMocks());

describe('POST /grapes/:id/approve', () => {
  test('clears pendingReview, saves, and audits', async () => {
    const doc = { _id: GRAPE_ID, name: 'Alvarão', pendingReview: true, save: jest.fn().mockResolvedValue(undefined) };
    Grape.findById.mockResolvedValue(doc);

    const res = await approve(GRAPE_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grape.pendingReview).toBe(false);
    expect(body.already).toBeUndefined();
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][1]).toBe('admin.taxonomy.approveGrape');
    expect(logAudit.mock.calls[0][2]).toEqual({ type: 'grape', id: GRAPE_ID });
  });

  test('idempotent: an already-reviewed grape answers already:true without a save or a second audit row', async () => {
    const doc = { _id: GRAPE_ID, name: 'Syrah', pendingReview: false, save: jest.fn() };
    Grape.findById.mockResolvedValue(doc);

    const res = await approve(GRAPE_ID);
    expect(res.status).toBe(200);
    expect((await res.json()).already).toBe(true);
    expect(doc.save).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('unknown id → 404, malformed id → 400', async () => {
    Grape.findById.mockResolvedValue(null);
    expect((await approve('64b0000000000000000000ff')).status).toBe(404);
    expect((await approve('not-an-id')).status).toBe(400);
  });
});
