/**
 * IDOR tests for GET /api/racks/nfc/:id (security audit 2026-07-08, L-4 —
 * re-rated from prior I-9).
 *
 * WHY THIS TEST EXISTS:
 * The NFC resolve endpoint used to return { cellarId, rackId, inRoom } for
 * ANY rack id to ANY authenticated user, leaking rack existence and the
 * rack→cellar linkage. The fix requires the requester to hold a role in the
 * rack's cellar (getCellarRole) and answers 404 — identical to a nonexistent
 * rack — otherwise, so the endpoint is not an existence oracle. This suite
 * pins that contract: member (owner/editor/viewer) → 200, non-member → the
 * same 404 body as a missing rack.
 *
 * The real racks router is mounted with the real requireAuth middleware
 * (HS256 test tokens); models are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const model = { findOne: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];
  return model;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({}));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const CellarLayout = require('../models/CellarLayout');
const racksRouter = require('./racks');

const OWNER_ID = '64b000000000000000000001';
const MEMBER_ID = '64b000000000000000000002';
const STRANGER_ID = '64b000000000000000000003';
const RACK_ID = '64b0000000000000000000aa';
const CELLAR_ID = '64b0000000000000000000bb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/racks', racksRouter);
  return app;
}

function makeReq(app, method, url, headers = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ port, path: url, method, headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          const body = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      req.end();
    });
  });
}

const tokenFor = (id) =>
  jwt.sign({ id, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });

const mockRackFound = () =>
  Rack.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: RACK_ID, cellar: CELLAR_ID }) });
const mockRackMissing = () =>
  Rack.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
const mockCellar = (doc) =>
  Cellar.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  CellarLayout.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
});

describe('GET /api/racks/nfc/:id ownership gate (L-4)', () => {
  test('cellar owner resolves their own rack → 200 with cellarId/rackId', async () => {
    mockRackFound();
    mockCellar({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });

    const { status, body } = await makeReq(buildApp(), 'GET', `/api/racks/nfc/${RACK_ID}`, {
      authorization: `Bearer ${tokenFor(OWNER_ID)}`,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ cellarId: CELLAR_ID, rackId: RACK_ID, inRoom: false });
  });

  test('cellar member (viewer) resolves the rack → 200', async () => {
    mockRackFound();
    mockCellar({
      _id: CELLAR_ID,
      user: OWNER_ID,
      members: [{ user: MEMBER_ID, role: 'viewer' }],
      deletedAt: null,
    });

    const { status, body } = await makeReq(buildApp(), 'GET', `/api/racks/nfc/${RACK_ID}`, {
      authorization: `Bearer ${tokenFor(MEMBER_ID)}`,
    });

    expect(status).toBe(200);
    expect(body.cellarId).toBe(CELLAR_ID);
  });

  test('authenticated NON-member gets 404, not the cellar linkage', async () => {
    mockRackFound();
    mockCellar({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });

    const { status, body } = await makeReq(buildApp(), 'GET', `/api/racks/nfc/${RACK_ID}`, {
      authorization: `Bearer ${tokenFor(STRANGER_ID)}`,
    });

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Rack not found' });
    expect(body.cellarId).toBeUndefined();
  });

  test('non-member 404 is byte-identical to the nonexistent-rack 404 (no existence oracle)', async () => {
    mockRackFound();
    mockCellar({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });
    const denied = await makeReq(buildApp(), 'GET', `/api/racks/nfc/${RACK_ID}`, {
      authorization: `Bearer ${tokenFor(STRANGER_ID)}`,
    });

    mockRackMissing();
    const missing = await makeReq(buildApp(), 'GET', `/api/racks/nfc/${RACK_ID}`, {
      authorization: `Bearer ${tokenFor(STRANGER_ID)}`,
    });

    expect(denied.status).toBe(missing.status);
    expect(denied.body).toEqual(missing.body);
  });

  test('rack in a soft-deleted cellar → 404 even for the owner', async () => {
    mockRackFound();
    mockCellar({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: new Date() });

    const { status } = await makeReq(buildApp(), 'GET', `/api/racks/nfc/${RACK_ID}`, {
      authorization: `Bearer ${tokenFor(OWNER_ID)}`,
    });

    expect(status).toBe(404);
  });

  test('unauthenticated request → 401 (route keeps requireAuth)', async () => {
    const { status } = await makeReq(buildApp(), 'GET', `/api/racks/nfc/${RACK_ID}`);
    expect(status).toBe(401);
  });
});
