/**
 * Offline-queue preconditions on the rack slot routes (#1355). A placement,
 * move or clear queued offline says which bottle the user saw in each slot it
 * touches; if the rack changed meanwhile (a partner placed a bottle there),
 * the route answers 409 instead of silently displacing that bottle. Absent →
 * unchanged behaviour. Harness from racks.group.test.js.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const model = { findOne: jest.fn() };
  model.RACK_TYPES = ['grid'];
  return model;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({}));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../models/IdempotencyRecord', () => ({}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({
  placeBottleInRack: jest.fn(async () => ({})),
  clearRackSlot: jest.fn(async () => ({})),
  normalizeRackGroup: (g) => g,
}));
jest.mock('../utils/maturityUtils', () => ({ buildProfileMap: jest.fn(async () => new Map()), classifyMaturity: jest.fn(() => null) }));
jest.mock('../utils/rackGeometry', () => ({
  cabinetShelfAlternate: jest.fn(), getMaxPosition: jest.fn(() => 32),
  validateDoubleHeightRows: jest.fn(() => null), validateCabinetConfig: jest.fn(() => null),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const { placeBottleInRack, clearRackSlot } = require('../services/rackOps');
const racksRouter = require('./racks');

const OWNER_ID = '64b000000000000000000001';
const RACK_ID = '64b0000000000000000000aa';
const CELLAR_ID = '64b0000000000000000000bb';
const MINE = '64b0000000000000000000b1';
const THEIRS = '64b0000000000000000000b2';
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


let rack;
beforeEach(() => {
  jest.clearAllMocks();
  rack = {
    _id: RACK_ID, cellar: CELLAR_ID, disabledPositions: [],
    slots: [{ position: 3, bottle: THEIRS }, { position: 5, bottle: MINE }],
    save: jest.fn(async () => {}),
    populate: jest.fn(async () => {}),
    toObject() { return { _id: this._id, slots: this.slots }; },
  };
  Rack.findOne.mockResolvedValue(rack);
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [] });
});

describe('place — expectOccupant', () => {
  test('the slot the user saw empty is now taken → 409, nobody displaced', async () => {
    const res = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}/slots/3`, { bottleId: MINE, expectOccupant: null });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slot_changed');
    expect(placeBottleInRack).not.toHaveBeenCalled();
  });
  test('still empty → placed', async () => {
    const res = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}/slots/7`, { bottleId: MINE, expectOccupant: null });
    expect(res.status).toBe(200);
    expect(placeBottleInRack).toHaveBeenCalledTimes(1);
  });
  test('without expectOccupant the old behaviour stands (displacing is allowed)', async () => {
    const res = await request(buildApp(), 'PUT', `/api/racks/${RACK_ID}/slots/3`, { bottleId: MINE });
    expect(res.status).toBe(200);
  });
});

describe('move — expectFrom / expectTo', () => {
  test('the source no longer holds the bottle the user moved → 409', async () => {
    const res = await request(buildApp(), 'POST', `/api/racks/${RACK_ID}/slots/3/move`, { toPosition: 9, expectFrom: MINE, expectTo: null });
    expect(res.status).toBe(409);
    expect(rack.save).not.toHaveBeenCalled();
  });
  test('the target the user saw empty is now taken → 409 (no surprise swap)', async () => {
    const res = await request(buildApp(), 'POST', `/api/racks/${RACK_ID}/slots/5/move`, { toPosition: 3, expectFrom: MINE, expectTo: null });
    expect(res.status).toBe(409);
  });
  test('as the user saw it → moved', async () => {
    const res = await request(buildApp(), 'POST', `/api/racks/${RACK_ID}/slots/5/move`, { toPosition: 9, expectFrom: MINE, expectTo: null });
    expect(res.status).toBe(200);
    expect(rack.slots.find((s) => String(s.bottle) === MINE).position).toBe(9);
  });
});

describe('clear — ?expect=', () => {
  test('a different bottle is in the slot now → 409', async () => {
    const res = await request(buildApp(), 'DELETE', `/api/racks/${RACK_ID}/slots/3?expect=${MINE}`);
    expect(res.status).toBe(409);
    expect(clearRackSlot).not.toHaveBeenCalled();
  });
  test('the bottle the user saw → cleared', async () => {
    const res = await request(buildApp(), 'DELETE', `/api/racks/${RACK_ID}/slots/5?expect=${MINE}`);
    expect(res.status).toBe(200);
    expect(clearRackSlot).toHaveBeenCalledTimes(1);
  });
});
