/**
 * What the retry ledger keeps of a slot write (middleware/idempotency). A
 * session's answer is the whole drawn rack, tens of kilobytes that no repeat
 * ever reads: the ledger keeps its status alone, and a repeat is told the write
 * was applied without applying it again. A token's answer is the public
 * contract (openapi/document.js PlaceResponse, UnplaceResponse) and is kept
 * whole. A refusal is an outcome and is repeated as it was answered. Harness
 * from racks.tokenAnswer.test.js, with the real middleware over an in-memory
 * ledger.
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
// In-memory stand-in for the ledger, enforcing the unique (user, key) index.
const mockLedger = new Map();
const mockLedgerKey = (q) => `${q.user}|${q.key}`;
jest.mock('../models/IdempotencyRecord', () => ({
  create: jest.fn(async (doc) => {
    const k = mockLedgerKey(doc);
    if (mockLedger.has(k)) { const e = new Error('dup'); e.code = 11000; throw e; }
    const row = { _id: k, status: null, body: null, createdAt: new Date(), ...doc };
    mockLedger.set(k, row);
    return row;
  }),
  findOne: jest.fn((q) => ({ lean: async () => (mockLedger.has(mockLedgerKey(q)) ? { ...mockLedger.get(mockLedgerKey(q)) } : null) })),
  updateOne: jest.fn(async ({ _id }, { $set }) => { if (mockLedger.has(_id)) Object.assign(mockLedger.get(_id), $set); }),
  deleteOne: jest.fn(async ({ _id }) => { mockLedger.delete(_id); }),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn() } }));
jest.mock('../services/rackOps', () => ({
  placeBottleInRack: jest.fn(),
  clearRackSlot: jest.fn(),
  normalizeRackGroup: (g) => g,
}));
jest.mock('../utils/maturityUtils', () => ({ buildProfileMap: jest.fn(async () => new Map()), classifyMaturity: jest.fn(() => 'peak') }));
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
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const kept = () => mockLedger.get(`${OWNER_ID}|${KEY}`);

function request(method, url, { body, asToken = false, key = KEY } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/racks', racksRouter);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        port: server.address().port, path: url, method,
        headers: {
          'content-type': 'application/json',
          ...(key ? { 'idempotency-key': key } : {}),
          ...(asToken ? { 'x-as-token': '1' } : {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, replayed: res.headers['idempotent-replayed'] || null, body: text ? JSON.parse(text) : null });
        });
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}
// The ledger is written after the answer has left.
const ledgerWritten = () => new Promise((r) => setTimeout(r, 20));

let rack;
beforeEach(() => {
  jest.clearAllMocks();
  mockLedger.clear();
  rack = {
    _id: RACK_ID, cellar: CELLAR_ID, disabledPositions: [],
    slots: [{ position: 3, bottle: THEIRS }, { position: 5, bottle: MINE }],
    save: jest.fn(async () => {}),
    // A populated slot carries the bottle with its wine: what makes the drawing large.
    populate: jest.fn(async function populate() {
      this.slots = this.slots.map((s) => ({ position: s.position, bottle: { _id: String(s.bottle._id || s.bottle), wineDefinition: { name: 'Barolo', producer: 'Cantina' } } }));
    }),
    toObject() { return { _id: this._id, slots: this.slots }; },
  };
  Rack.findOne.mockResolvedValue(rack);
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [] });
  placeBottleInRack.mockResolvedValue({ displaced: { bottleId: THEIRS, position: 3 } });
  clearRackSlot.mockResolvedValue({ cleared: { bottleId: THEIRS, position: 3 } });
});

describe('a session — the drawn rack is answered, never kept', () => {
  test('place: the answer is the drawn rack, the ledger keeps the status alone', async () => {
    const first = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE } });
    expect(first.status).toBe(200);
    expect(first.replayed).toBeNull();
    expect(first.body.rack.slots[0].bottle.wineDefinition.name).toBe('Barolo');
    await ledgerWritten();
    expect(kept()).toMatchObject({ status: 200, body: { replayed: true } });
  });

  test('place: a repeat is told it was applied, and the bottle is placed once', async () => {
    await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE } });
    await ledgerWritten();
    const again = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE } });
    expect(again.status).toBe(200);
    expect(again.replayed).toBe('true');
    expect(again.body).toEqual({ replayed: true });
    expect(placeBottleInRack).toHaveBeenCalledTimes(1);
  });

  test('clear: the same, and the slot is cleared once', async () => {
    const first = await request('DELETE', `/api/racks/${RACK_ID}/slots/3`);
    expect(first.body.rack.slots).toHaveLength(2);
    await ledgerWritten();
    expect(kept().body).toEqual({ replayed: true });
    const again = await request('DELETE', `/api/racks/${RACK_ID}/slots/3`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ replayed: true });
    expect(clearRackSlot).toHaveBeenCalledTimes(1);
  });

  test('move: the same, and the rack is saved once', async () => {
    const first = await request('POST', `/api/racks/${RACK_ID}/slots/5/move`, { body: { toPosition: 7 } });
    expect(first.status).toBe(200);
    expect(first.body.rack.slots.map((s) => s.position).sort()).toEqual([3, 7]);
    await ledgerWritten();
    expect(kept().body).toEqual({ replayed: true });
    const again = await request('POST', `/api/racks/${RACK_ID}/slots/5/move`, { body: { toPosition: 7 } });
    expect(again.status).toBe(200);
    expect(again.replayed).toBe('true');
    expect(rack.save).toHaveBeenCalledTimes(1);
  });

  test('a refusal is kept and repeated as it was answered', async () => {
    const first = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE, expectOccupant: null } });
    expect(first.status).toBe(409);
    await ledgerWritten();
    expect(kept()).toMatchObject({ status: 409, body: { code: 'slot_changed' } });
    const again = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE, expectOccupant: null } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('slot_changed');
    expect(placeBottleInRack).not.toHaveBeenCalled();
  });
});

describe('an API token — the contract answer is kept whole', () => {
  test('place: the repeat gets the first answer back, displaced bottle included', async () => {
    const first = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE }, asToken: true });
    await ledgerWritten();
    expect(kept().body).toEqual(first.body);
    const again = await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE }, asToken: true });
    expect(again.replayed).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(again.body.displaced).toEqual({ bottleId: THEIRS, position: 3 });
    expect(placeBottleInRack).toHaveBeenCalledTimes(1);
  });

  test('clear: the repeat names the bottle the first call removed', async () => {
    const first = await request('DELETE', `/api/racks/${RACK_ID}/slots/3`, { asToken: true });
    await ledgerWritten();
    const again = await request('DELETE', `/api/racks/${RACK_ID}/slots/3`, { asToken: true });
    expect(again.body).toEqual(first.body);
    expect(again.body.removed).toEqual({ bottleId: THEIRS, position: 3 });
    expect(clearRackSlot).toHaveBeenCalledTimes(1);
  });
});

test('without the header nothing is kept and the write runs each time', async () => {
  await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE }, key: null });
  await request('PUT', `/api/racks/${RACK_ID}/slots/3`, { body: { bottleId: MINE }, key: null });
  expect(placeBottleInRack).toHaveBeenCalledTimes(2);
  expect(mockLedger.size).toBe(0);
});
