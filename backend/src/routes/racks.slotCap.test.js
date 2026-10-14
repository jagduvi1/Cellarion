/**
 * A rack's slots in total (audit 2026-10-14): within the per-module bounds
 * alone, a modular rack could legally hold two million slots, which every
 * member's racks page, print map and room then drew one by one. Create and
 * update refuse a rack past MAX_RACK_SLOTS; ordinary shapes are untouched.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const instances = [];
  function Rack(data) {
    Object.assign(this, data);
    this._id = '64b0000000000000000000aa';
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Rack.__instances = instances;
  Rack.findOne = jest.fn();
  Rack.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf', 'cabinet'];
  return Rack;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({}));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({
  createGridRack: jest.fn(),
  normalizeRackGroup: jest.requireActual('../services/rackOps').normalizeRackGroup,
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
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

// 50 cubes of 20×20 cells with 10×10 bottles each: 2,000,000 slots.
const HUGE = Array.from({ length: 50 }, () => ({ type: 'cube', rows: 20, cols: 20, typeConfig: { moduleRows: 10, moduleCols: 10 } }));
// A real wall: six 10×10 grids.
const WALL = Array.from({ length: 6 }, () => ({ type: 'grid', rows: 10, cols: 10 }));

const rackDoc = (over = {}) => {
  const doc = {
    _id: RACK_ID, cellar: CELLAR_ID, name: 'Wall', group: null, type: 'grid', rows: 4, cols: 8,
    isModular: true, modules: WALL, slots: [], disabledPositions: [], zones: [], ...over,
  };
  doc.save = jest.fn().mockResolvedValue(doc);
  doc.populate = jest.fn().mockResolvedValue(doc);
  doc.toObject = () => ({ ...doc });
  return doc;
};

beforeEach(() => {
  jest.clearAllMocks();
  Rack.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });
});

describe('MAX_RACK_SLOTS', () => {
  test('POST refuses a modular rack past the cap, before anything is saved', async () => {
    const { status, body } = await request(buildApp(), 'POST', '/api/racks', { cellar: CELLAR_ID, name: 'Wall', isModular: true, modules: HUGE });
    expect(status).toBe(400);
    expect(body.error).toMatch(/at most 10000 slots/);
    expect(Rack.__instances).toHaveLength(0);
  });

  test('POST stores an ordinary modular wall', async () => {
    const { status } = await request(buildApp(), 'POST', '/api/racks', { cellar: CELLAR_ID, name: 'Wall', isModular: true, modules: WALL });
    expect(status).toBe(201);
    expect(Rack.__instances).toHaveLength(1);
    expect(Rack.__instances[0].save).toHaveBeenCalled();
  });

  test('PUT refuses growing a rack past the cap and keeps the stored modules', async () => {
    const doc = rackDoc();
    Rack.findOne.mockResolvedValue(doc);
    const { status, body } = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}`, { isModular: true, modules: HUGE });
    expect(status).toBe(400);
    expect(body.error).toMatch(/at most 10000 slots/);
    expect(doc.modules).toBe(WALL);
    expect(doc.save).not.toHaveBeenCalled();
  });
});
