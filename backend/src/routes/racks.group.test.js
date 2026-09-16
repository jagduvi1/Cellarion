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
  cabinetShelfAlternate: jest.requireActual('../utils/rackGeometry').cabinetShelfAlternate,
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

  test('the alternate flag rides along untouched, and a non-boolean one is refused', async () => {
    // An EMPTY cabinet: on a loaded one whose rows alternate, two-deep is
    // part of the shape and locked (pinned below, audit 2026-09-16).
    const doc = cabinet({ typeConfig: { shelfRows: [2, 2, 2], twoDeep: true, stagger: true, alternate: true }, slots: [] });
    Rack.findOne.mockResolvedValue(doc);
    const ok = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, {
      typeConfig: { shelfRows: [2, 2, 2], twoDeep: false, stagger: true, alternate: true },
    });
    expect(ok.status).toBe(200);
    expect(doc.typeConfig).toEqual({ shelfRows: [2, 2, 2], twoDeep: false, stagger: true, alternate: true });

    const bad = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, {
      typeConfig: { shelfRows: [2, 2, 2], twoDeep: true, stagger: true, alternate: 'yes' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/alternate must be a boolean/);
  });

  test('per-shelf lists ride along, and a shelf wider than the cabinet is refused', async () => {
    const shape = { shelfRows: [2, 2, 2], twoDeep: true, stagger: true, alternate: false, shelfCols: [3, 4, 4], shelfAlternate: [false, true, true] };
    const doc = cabinet({ typeConfig: shape });
    Rack.findOne.mockResolvedValue(doc);
    const ok = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { typeConfig: { ...shape, stagger: false } });
    expect(ok.status).toBe(200);
    expect(doc.typeConfig).toEqual({ ...shape, stagger: false });

    const bad = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { typeConfig: { ...shape, shelfCols: [3, 5, 4] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/cabinet width \(4\)/);
  });

  test('a narrower cols alone is checked against the stored per-shelf widths (audit 2026-09-16)', async () => {
    const doc = cabinet({ typeConfig: { shelfRows: [2, 2, 2], shelfCols: [4, 3, 4], twoDeep: true, stagger: true } });
    Rack.findOne.mockResolvedValue(doc);
    const { status, body } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { cols: 3 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/shelfCols/);
    expect(doc.save).not.toHaveBeenCalled();
    // Narrowing to a width every shelf fits is still fine.
    const ok = cabinet({ typeConfig: { shelfRows: [2, 2, 2], shelfCols: [3, 3, 3], twoDeep: true, stagger: true } });
    Rack.findOne.mockResolvedValue(ok);
    expect((await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { cols: 3 })).status).toBe(200);
  });

  test('two-deep is fixed on a LOADED cabinet whose rows alternate — it sets which rows are the narrow ones', async () => {
    const shape = { shelfRows: [2, 2, 2], twoDeep: true, stagger: true, alternate: true };
    const loaded = cabinet({ typeConfig: { ...shape } });
    Rack.findOne.mockResolvedValue(loaded);
    const { status, body } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { typeConfig: { ...shape, twoDeep: false } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Two deep/);
    expect(loaded.save).not.toHaveBeenCalled();
    // The same flag sent back is not a change; an EMPTY cabinet may still flip it.
    Rack.findOne.mockResolvedValue(cabinet({ typeConfig: { ...shape } }));
    expect((await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { typeConfig: { ...shape } })).status).toBe(200);
    Rack.findOne.mockResolvedValue(cabinet({ typeConfig: { ...shape }, slots: [] }));
    expect((await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { typeConfig: { ...shape, twoDeep: false } })).status).toBe(200);
    // A plain cabinet (no alternating bay) keeps two-deep drawing-only.
    Rack.findOne.mockResolvedValue(cabinet());
    expect((await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { typeConfig: { shelfRows: [2, 2, 2], twoDeep: false, stagger: true } })).status).toBe(200);
  });

  test('a shape edit is audited with both sides; a rename carries no shape (audit 2026-09-16)', async () => {
    const { logAudit } = require('../services/audit');
    Rack.findOne.mockResolvedValue(cabinet({ slots: [] }));
    await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { typeConfig: { shelfRows: [2, 2, 2], twoDeep: false, stagger: true } });
    const meta = logAudit.mock.calls.find((c) => c[1] === 'rack.update')[3];
    expect(meta.shape.from.typeConfig.twoDeep).toBe(true);
    expect(meta.shape.to.typeConfig.twoDeep).toBe(false);
    logAudit.mockClear();
    Rack.findOne.mockResolvedValue(cabinet({ slots: [] }));
    await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { name: 'Renamed' });
    expect(logAudit.mock.calls.find((c) => c[1] === 'rack.update')[3].shape).toBeUndefined();
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
