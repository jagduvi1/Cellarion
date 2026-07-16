/**
 * REST auto-arrange endpoints — one-engine contract tests.
 *
 * POST /api/racks/:id/arrange/preview and .../apply expose the SAME decision
 * engine + atomic apply the MCP auto_arrange tool uses. This suite pins the
 * web contract's own guarantees: role gating, the stateless staleness guard
 * (`before` must equal current occupancy), permutation-only targets (a
 * hand-crafted request can reorder but never inject/clone/drop bottles),
 * geometry re-validation, and the one-save atomicity.
 *
 * The real racks router is mounted with the real requireAuth middleware
 * (HS256 test tokens); models are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const model = { findOne: jest.fn(), updateMany: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];
  return model;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findOne: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const WineVintageProfile = require('../models/WineVintageProfile');
const { logAudit } = require('../services/audit');
const racksRouter = require('./racks');

const OWNER_ID = '64b000000000000000000001';
const VIEWER_ID = '64b000000000000000000002';
const RACK_ID = '64b0000000000000000000aa';
const CELLAR_ID = '64b0000000000000000000bb';
const B1 = '64b0000000000000000000c1';
const B2 = '64b0000000000000000000c2';
const B3 = '64b0000000000000000000c3';

const token = (id) => jwt.sign({ id, roles: ['user'] }, 'test-secret');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/racks', racksRouter);
  return app;
}

function makeReq(app, method, url, { body, auth } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        port, path: url, method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

/**
 * A 2x2 grid rack whose two bottles are in reverse-vintage order (so the
 * vintage strategy always has work). slots.bottle is "populated" for preview
 * and a raw ObjectId-string for apply — mirrors what each route loads.
 */
function mkRack({ populated = false, slots } = {}) {
  const bottleDoc = (id, vintage, name) => (populated
    ? { _id: id, vintage, status: 'active', wineDefinition: { name, producer: 'P', type: 'red' } }
    : id);
  const rack = {
    _id: RACK_ID,
    cellar: CELLAR_ID,
    name: 'R',
    type: 'grid', rows: 2, cols: 2, isModular: false,
    disabledPositions: [],
    slots: slots || [
      { position: 1, bottle: bottleDoc(B1, '2023', 'Young') },
      { position: 2, bottle: bottleDoc(B2, '1999', 'Old') },
    ],
    save: jest.fn().mockResolvedValue({}),
    populate: jest.fn().mockResolvedValue({}),
    toObject() { return { ...this }; },
  };
  return rack;
}

const ownerCellar = () => Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });
const viewerCellar = () => Cellar.findById.mockResolvedValue({
  _id: CELLAR_ID, user: '64b0000000000000000000ff',
  members: [{ user: VIEWER_ID, role: 'viewer' }], deletedAt: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([]) });
});

describe('preview', () => {
  test('computes the plan with before/target/changes for an editor+', async () => {
    const rack = mkRack({ populated: true });
    Rack.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(rack) });
    ownerCellar();
    const res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/preview`,
      { auth: token(OWNER_ID), body: { strategy: 'vintage' } });
    expect(res.status).toBe(200);
    expect(res.body.bottlesTotal).toBe(2);
    expect(res.body.before).toEqual([
      { position: 1, bottleId: B1 }, { position: 2, bottleId: B2 },
    ]);
    expect(res.body.target).toEqual([
      { position: 1, bottleId: B2 }, { position: 2, bottleId: B1 },
    ]);
    expect(res.body.changes).toHaveLength(2);
    expect(res.body.changes[0]).toMatchObject({ to: 1, name: 'Old', vintage: '1999' });
    expect(rack.save).not.toHaveBeenCalled(); // preview never mutates
  });

  test('honors a client positionOrder; rejects a malformed one', async () => {
    const rack = mkRack({ populated: true });
    Rack.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(rack) });
    ownerCellar();
    const good = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/preview`,
      { auth: token(OWNER_ID), body: { strategy: 'vintage', positionOrder: [4, 3, 2, 1] } });
    expect(good.status).toBe(200);
    expect(good.body.target).toEqual([
      { position: 4, bottleId: B2 }, { position: 3, bottleId: B1 },
    ]);

    Rack.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(mkRack({ populated: true })) });
    ownerCellar();
    const bad = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/preview`,
      { auth: token(OWNER_ID), body: { positionOrder: [1, 1, 2] } });
    expect(bad.status).toBe(400);
  });

  test('viewer → 403; missing rack → 404; bad strategy → 400', async () => {
    const rack = mkRack({ populated: true });
    Rack.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(rack) });
    viewerCellar();
    let res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/preview`,
      { auth: token(VIEWER_ID), body: {} });
    expect(res.status).toBe(403);

    Rack.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
    res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/preview`,
      { auth: token(OWNER_ID), body: {} });
    expect(res.status).toBe(404);

    Rack.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(mkRack({ populated: true })) });
    ownerCellar();
    res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/preview`,
      { auth: token(OWNER_ID), body: { strategy: 'chaos' } });
    expect(res.status).toBe(400);
  });
});

describe('apply', () => {
  const PLAN = {
    before: [{ position: 1, bottleId: B1 }, { position: 2, bottleId: B2 }],
    target: [{ position: 1, bottleId: B2 }, { position: 2, bottleId: B1 }],
  };

  test('applies the permutation in ONE save and returns the refreshed rack', async () => {
    const rack = mkRack();
    Rack.findOne.mockResolvedValue(rack);
    ownerCellar();
    const res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(OWNER_ID), body: PLAN });
    expect(res.status).toBe(200);
    expect(rack.save).toHaveBeenCalledTimes(1);
    expect(rack.slots.map((s) => ({ position: s.position, bottle: String(s.bottle) }))).toEqual([
      { position: 1, bottle: B2 }, { position: 2, bottle: B1 },
    ]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rack.arrange', expect.anything(),
      expect.objectContaining({ via: 'web' }));
  });

  test('undo is the same endpoint with the layouts swapped', async () => {
    const rack = mkRack({ slots: [{ position: 1, bottle: B2 }, { position: 2, bottle: B1 }] }); // applied state
    Rack.findOne.mockResolvedValue(rack);
    ownerCellar();
    const res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(OWNER_ID), body: { target: PLAN.before, before: PLAN.target } });
    expect(res.status).toBe(200);
    expect(rack.slots.map((s) => ({ position: s.position, bottle: String(s.bottle) }))).toEqual([
      { position: 1, bottle: B1 }, { position: 2, bottle: B2 },
    ]);
  });

  test('stale plan (rack changed since preview) → 409, nothing saved', async () => {
    const rack = mkRack({ slots: [{ position: 1, bottle: B1 }, { position: 3, bottle: B2 }] }); // B2 moved
    Rack.findOne.mockResolvedValue(rack);
    ownerCellar();
    const res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(OWNER_ID), body: PLAN });
    expect(res.status).toBe(409);
    expect(rack.save).not.toHaveBeenCalled();
  });

  test('target that injects a foreign bottle or clones one → 400, nothing saved', async () => {
    const inject = { before: PLAN.before, target: [{ position: 1, bottleId: B3 }, { position: 2, bottleId: B1 }] };
    let rack = mkRack();
    Rack.findOne.mockResolvedValue(rack);
    ownerCellar();
    let res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(OWNER_ID), body: inject });
    expect(res.status).toBe(400);
    expect(rack.save).not.toHaveBeenCalled();

    const clone = { before: PLAN.before, target: [{ position: 1, bottleId: B1 }, { position: 2, bottleId: B1 }] };
    rack = mkRack();
    Rack.findOne.mockResolvedValue(rack);
    ownerCellar();
    res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(OWNER_ID), body: clone });
    expect(res.status).toBe(400);
    expect(rack.save).not.toHaveBeenCalled();
  });

  test('target onto a disabled position → 409 (geometry re-checked at write time)', async () => {
    const rack = mkRack();
    rack.disabledPositions = [2];
    Rack.findOne.mockResolvedValue(rack);
    ownerCellar();
    const res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(OWNER_ID), body: PLAN });
    expect(res.status).toBe(409);
    expect(rack.save).not.toHaveBeenCalled();
  });

  test('concurrent modification (VersionError on save) → 409', async () => {
    const rack = mkRack();
    rack.save.mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    Rack.findOne.mockResolvedValue(rack);
    ownerCellar();
    const res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(OWNER_ID), body: PLAN });
    expect(res.status).toBe(409);
  });

  test('viewer → 403 before any state is touched', async () => {
    const rack = mkRack();
    Rack.findOne.mockResolvedValue(rack);
    viewerCellar();
    const res = await makeReq(buildApp(), 'POST', `/api/racks/${RACK_ID}/arrange/apply`,
      { auth: token(VIEWER_ID), body: PLAN });
    expect(res.status).toBe(403);
    expect(rack.save).not.toHaveBeenCalled();
  });
});
