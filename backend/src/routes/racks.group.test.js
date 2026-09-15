/**
 * Rack group on the REST routes (support ticket 2026-09-06, discussion #1228):
 * POST passes the group to the shared grid creator, PUT stores it normalised
 * and clears it on '', and the update audit row now names the cellar.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const model = { findOne: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf', 'cabinet'];
  return model;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({}));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({
  createGridRack: jest.fn(),
  normalizeRackGroup: jest.requireActual('../services/rackOps').normalizeRackGroup,
}));
jest.mock('../utils/rackGeometry', () => ({
  getMaxPosition: jest.fn(() => 32),
  validateDoubleHeightRows: jest.fn(() => null),
  // Real validator — the cabinet gate is part of the pinned PUT contract.
  validateCabinetConfig: jest.requireActual('../utils/rackGeometry').validateCabinetConfig,
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const { createGridRack } = require('../services/rackOps');
const { logAudit } = require('../services/audit');
const racksRouter = require('./racks');

const OWNER_ID = '64b000000000000000000001';
const RACK_ID = '64b0000000000000000000aa';
const CELLAR_ID = '64b0000000000000000000bb';
const tokenFor = (id) => jwt.sign({ id, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/racks', racksRouter);
  return app;
}
function request(app, method, url, body) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        port, path: url, method,
        headers: { authorization: `Bearer ${tokenFor(OWNER_ID)}`, 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// A rack document the PUT route can mutate and save.
const rackDoc = (over = {}) => {
  const doc = {
    _id: RACK_ID, cellar: CELLAR_ID, name: 'Left', group: null, type: 'grid', rows: 4, cols: 8,
    slots: [], disabledPositions: [], zones: [], ...over,
  };
  doc.save = jest.fn().mockResolvedValue(doc);
  doc.populate = jest.fn().mockResolvedValue(doc);
  doc.toObject = () => ({ ...doc });
  return doc;
};

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });
});

describe('PUT /api/racks/:id group', () => {
  test('stores the trimmed group and audits it with the cellar', async () => {
    const doc = rackDoc();
    Rack.findOne.mockResolvedValue(doc);
    const { status, body } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { group: '  Basement ' });
    expect(status).toBe(200);
    expect(doc.group).toBe('Basement');
    expect(doc.save).toHaveBeenCalled();
    expect(body.rack.group).toBe('Basement');
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rack.update',
      expect.objectContaining({ type: 'rack', id: RACK_ID, cellarId: CELLAR_ID }), { name: 'Left', group: 'Basement' });
  });

  test("an empty group clears it; a request without the field leaves it alone", async () => {
    const doc = rackDoc({ group: 'Basement' });
    Rack.findOne.mockResolvedValue(doc);
    await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { group: '' });
    expect(doc.group).toBeNull();

    const untouched = rackDoc({ group: 'Basement' });
    Rack.findOne.mockResolvedValue(untouched);
    await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { name: 'Left wall' });
    expect(untouched.group).toBe('Basement');
    expect(untouched.name).toBe('Left wall');
  });
});

describe('POST /api/racks group', () => {
  test('a grid rack passes the group through to the shared creator', async () => {
    createGridRack.mockResolvedValue({ rack: { _id: RACK_ID, name: 'Left', group: 'Basement' } });
    const { status, body } = await request(buildApp(), 'POST', '/api/racks', { cellar: CELLAR_ID, name: 'Left', rows: 4, cols: 8, group: 'Basement' });
    expect(status).toBe(201);
    expect(createGridRack).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'Left', group: 'Basement' }), expect.anything());
    expect(body.rack.group).toBe('Basement');
  });
});

describe('PUT /api/racks/:id group validation (audit 2026-09-07)', () => {
  test('a non-string group is a 400, not a silent un-group', async () => {
    const doc = rackDoc({ group: 'Basement' });
    Rack.findOne.mockResolvedValue(doc);
    const { status } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { group: 5 });
    expect(status).toBe(400);
    expect(doc.group).toBe('Basement');
    expect(doc.save).not.toHaveBeenCalled();
  });
});

// ── A cabinet's drawing-only options are editable after creation ────────────
// twoDeep and stagger change how the cabinet is DRAWN; capacity and slot
// numbering are untouched, so flipping them on a loaded rack must not move a
// bottle. The shape (rows / cols / shelfRows) stays creation-only.
describe('PUT /api/racks/:id cabinet options', () => {
  const cabinet = (over = {}) => rackDoc({
    type: 'cabinet', rows: 3, cols: 4,
    typeConfig: { shelfRows: [2, 2, 2], twoDeep: true, stagger: true },
    slots: [{ position: 7, bottle: '64b0000000000000000000cc' }],
    ...over,
  });

  test('turning nesting off keeps the shape, the slots and the capacity', async () => {
    const doc = cabinet();
    Rack.findOne.mockResolvedValue(doc);
    const { status } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, {
      name: 'Fridge', group: '', typeConfig: { shelfRows: [2, 2, 2], twoDeep: true, stagger: false },
    });
    expect(status).toBe(200);
    expect(doc.typeConfig).toEqual({ shelfRows: [2, 2, 2], twoDeep: true, stagger: false });
    expect(doc.rows).toBe(3);
    expect(doc.cols).toBe(4);
    expect(doc.slots).toEqual([{ position: 7, bottle: '64b0000000000000000000cc' }]);
    expect(doc.save).toHaveBeenCalled();
  });

  test('a typeConfig that drops the shelf list is refused, so the shape cannot be lost', async () => {
    const doc = cabinet();
    Rack.findOne.mockResolvedValue(doc);
    const { status, body } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, {
      typeConfig: { twoDeep: false, stagger: false },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/shelfRows is required/);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('a shelf list that no longer matches the shelf count is refused', async () => {
    const doc = cabinet();
    Rack.findOne.mockResolvedValue(doc);
    const { status, body } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, {
      typeConfig: { shelfRows: [2, 2], twoDeep: true, stagger: true },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/one entry per shelf/);
  });

  test('renaming a cabinet without touching its shape still works', async () => {
    const doc = cabinet();
    Rack.findOne.mockResolvedValue(doc);
    const { status } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { name: 'Kitchen fridge' });
    expect(status).toBe(200);
    expect(doc.name).toBe('Kitchen fridge');
    expect(doc.typeConfig).toEqual({ shelfRows: [2, 2, 2], twoDeep: true, stagger: true });
  });
});
