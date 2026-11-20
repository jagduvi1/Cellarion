/**
 * What a slot write answers, by caller. An API token gets the public contract
 * (openapi/document.js PlaceResponse, UnplaceResponse): the rack in summary
 * form plus the other bottle the write touched. A session gets the rack as
 * the racks page draws it, and nothing else. openapi/contract.test.js checks
 * the token answers on a real database; this holds the two apart without one.
 */
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: '64b000000000000000000001' };
    if (req.headers['x-as-token']) req.apiToken = { id: '64b0000000000000000000cc', scopes: ['write'] };
    next();
  },
}));
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
  placeBottleInRack: jest.fn(),
  clearRackSlot: jest.fn(),
  normalizeRackGroup: (g) => g,
}));
jest.mock('../utils/maturityUtils', () => ({ buildProfileMap: jest.fn(async () => new Map()), classifyMaturity: jest.fn(() => null) }));
jest.mock('../utils/rackGeometry', () => ({
  cabinetShelfAlternate: jest.fn(), getMaxPosition: jest.fn(() => 32),
  validateDoubleHeightRows: jest.fn(() => null), validateCabinetConfig: jest.fn(() => null),
}));

const express = require('express');
const http = require('http');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const { placeBottleInRack, clearRackSlot } = require('../services/rackOps');
const racksRouter = require('./racks');

const OWNER_ID = '64b000000000000000000001';
const RACK_ID = '64b0000000000000000000aa';
const CELLAR_ID = '64b0000000000000000000bb';
const MINE = '64b0000000000000000000b1';
const THEIRS = '64b0000000000000000000b2';

function request(method, url, { body, asToken = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/racks', racksRouter);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        port: server.address().port, path: url, method,
        headers: { 'content-type': 'application/json', ...(asToken ? { 'x-as-token': '1' } : {}), ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); });
      });
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
    slots: [{ position: 3, bottle: MINE }],
    populate: jest.fn(async () => {}),
    toObject() { return { _id: this._id, cellar: this.cellar, slots: this.slots }; },
  };
  Rack.findOne.mockResolvedValue(rack);
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [] });
  placeBottleInRack.mockResolvedValue({ rack, displaced: THEIRS, previousPosition: null, position: 3 });
  clearRackSlot.mockResolvedValue({ rack, cleared: MINE });
});

describe('PUT /api/racks/:id/slots/:position', () => {
  test('a token gets the summary rack and the displaced bottle, without loading the placed bottles', async () => {
    const res = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE }, asToken: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rack: { _id: RACK_ID, cellar: CELLAR_ID, slots: [{ position: 3, bottle: MINE }] }, displaced: THEIRS });
    expect(rack.populate).not.toHaveBeenCalled();
  });

  test('a token placing into a free slot is told nothing was displaced', async () => {
    placeBottleInRack.mockResolvedValue({ rack, displaced: null, previousPosition: 7, position: 3 });
    const res = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE }, asToken: true });
    expect(res.body.displaced).toBeNull();
  });

  test('a session gets the populated rack and nothing else', async () => {
    const res = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['rack']);
    expect(rack.populate).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/racks/:id/slots/:position', () => {
  test('a token gets the summary rack and the bottle taken out', async () => {
    const res = await request('DELETE', `/api/racks/${RACK_ID}/slots/3`, { asToken: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rack: { _id: RACK_ID, cellar: CELLAR_ID, slots: [{ position: 3, bottle: MINE }] }, removed: MINE });
    expect(rack.populate).not.toHaveBeenCalled();
  });

  test('a token emptying a slot that was already empty is told so', async () => {
    clearRackSlot.mockResolvedValue({ rack, cleared: null });
    const res = await request('DELETE', `/api/racks/${RACK_ID}/slots/9`, { asToken: true });
    expect(res.body.removed).toBeNull();
  });

  test('a session gets the populated rack and nothing else', async () => {
    const res = await request('DELETE', `/api/racks/${RACK_ID}/slots/3`);
    expect(Object.keys(res.body)).toEqual(['rack']);
    expect(rack.populate).toHaveBeenCalledTimes(1);
  });
});
