/**
 * What the rack routes send about the bottles in their slots.
 *
 * Scaling audit 2026-09-25: GET /api/racks populated whole bottle, wine and
 * taxonomy documents. A large cellar came to about 5 MB (mostly taxonomy
 * descriptions), and every shared wine's label-scan evidence, AI profile and
 * creator reached any viewer of the cellar. Pinned here: every rack response
 * populates the list projection (lean, taxonomy names only), and ?summary=1
 * sends slot bottle ids without populating anything.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const model = { find: jest.fn(), findOne: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf', 'cabinet'];
  return model;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({}));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({
  createGridRack: jest.fn(),
  placeBottleInRack: jest.fn(),
  clearRackSlot: jest.fn().mockResolvedValue({}),
  normalizeRackGroup: jest.fn((g) => g),
}));
jest.mock('../utils/maturityUtils', () => ({
  buildProfileMap: jest.fn().mockResolvedValue(new Map()),
  classifyMaturity: jest.fn(() => 'peak'),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const racksRouter = require('./racks');

const OWNER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const RACK_ID = '64b0000000000000000000aa';
const BOTTLE_ID = '64b0000000000000000000cc';

function request(method, url) {
  const app = express();
  app.use(express.json());
  app.use('/api/racks', racksRouter);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: url, method,
        headers: { authorization: `Bearer ${jwt.sign({ id: OWNER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      req.end();
    });
  });
}

const placedBottle = () => ({
  _id: BOTTLE_ID, vintage: '2018',
  wineDefinition: { _id: 'w1', name: 'Château Margaux', producer: 'Château Margaux', type: 'red', country: { _id: 'c1', name: 'France' } },
});
// A rack document: populate() swaps in the placed bottle, as Mongoose would.
const rackDoc = ({ populated = false } = {}) => {
  const doc = {
    _id: RACK_ID, cellar: CELLAR_ID, name: 'Left', type: 'grid', rows: 4, cols: 8,
    slots: [{ position: 1, bottle: populated ? placedBottle() : BOTTLE_ID }],
    disabledPositions: [], zones: [],
  };
  doc.populate = jest.fn(async () => { doc.slots = [{ position: 1, bottle: placedBottle() }]; return doc; });
  doc.toObject = () => JSON.parse(JSON.stringify({ ...doc, populate: undefined }));
  return doc;
};
// Rack.find(...) is awaited directly (summary) or through .populate(spec).
const findResult = (docs) => {
  const q = Promise.resolve(docs);
  q.populate = jest.fn(async (spec) => { for (const d of docs) await d.populate(spec); return docs; });
  return q;
};

// The one projection every rack response must use.
function expectSlotProjection(spec) {
  expect(spec.path).toBe('slots.bottle');
  expect(spec.options).toEqual({ lean: true });
  const wine = spec.populate.find((p) => p.path === 'wineDefinition');
  for (const hidden of ['-aiProfile', '-createdBy', '-normalizedKey', '-scanImage', '-scanImageBack', '-scanFieldConflicts']) {
    expect(wine.select.split(/\s+/)).toContain(hidden);
  }
  expect(wine.populate).toEqual([
    { path: 'country', select: 'name' },
    { path: 'region', select: 'name' },
    { path: 'grapes', select: 'name' },
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: OWNER_ID, members: [], deletedAt: null });
});

describe('GET /api/racks', () => {
  test('the rack view gets the list projection — lean, no scan evidence, taxonomy names only — with maturity', async () => {
    const docs = [rackDoc()];
    const q = findResult(docs);
    Rack.find.mockReturnValue(q);

    const res = await request('GET', `/api/racks?cellar=${CELLAR_ID}`);

    expect(res.status).toBe(200);
    expect(Rack.find).toHaveBeenCalledWith({ cellar: CELLAR_ID, deletedAt: null });
    expect(q.populate).toHaveBeenCalledTimes(1);
    expectSlotProjection(q.populate.mock.calls[0][0]);
    const slot = res.body.racks[0].slots[0];
    expect(slot.bottle.wineDefinition.name).toBe('Château Margaux');
    expect(slot.bottle.maturityStatus).toBe('peak');
  });

  test('?summary=1 sends slot bottle ids and populates nothing', async () => {
    const q = findResult([rackDoc()]);
    Rack.find.mockReturnValue(q);

    const res = await request('GET', `/api/racks?cellar=${CELLAR_ID}&summary=1`);

    expect(res.status).toBe(200);
    expect(q.populate).not.toHaveBeenCalled();
    expect(res.body.racks[0]).toMatchObject({ name: 'Left', type: 'grid', zones: [] });
    expect(res.body.racks[0].slots).toEqual([{ position: 1, bottle: BOTTLE_ID }]);
  });
});

describe('rack changes answer with the same projection', () => {
  test('DELETE /api/racks/:id/slots/:position', async () => {
    const doc = rackDoc();
    Rack.findOne.mockResolvedValue(doc);

    const res = await request('DELETE', `/api/racks/${RACK_ID}/slots/1`);

    expect(res.status).toBe(200);
    expect(doc.populate).toHaveBeenCalledTimes(1);
    expectSlotProjection(doc.populate.mock.calls[0][0]);
  });

  test('no rack route populates whole documents any more', () => {
    const src = require('fs').readFileSync(require.resolve('./racks'), 'utf8');
    // Every slots.bottle populate goes through SLOT_BOTTLES, except the
    // arrange preview's own even slimmer one (name producer type).
    const inline = src.match(/populate\(\{\s*path: 'slots\.bottle'[\s\S]*?\}\)/g) || [];
    for (const block of inline) expect(block).toMatch(/select: 'name producer type'/);
    expect(src).not.toMatch(/populate: \['country', 'region', 'grapes'\]/);
  });
});
