/**
 * Who may reach a rack through its id. The routes under /api/racks/:id reach
 * the cellar through the rack, and answer the way requireCellarAccess does:
 * a missing or soft-deleted cellar and a caller with no role on it read
 * exactly like a rack that does not exist (404 'Rack not found'); only a
 * member below the route's role gets a 403, with the route's own message.
 *
 * The real racks router is mounted with the real requireAuth middleware
 * (HS256 test tokens); models are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const model = { findOne: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf', 'cabinet'];
  return model;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findOne: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/maturityUtils', () => ({ buildProfileMap: jest.fn(async () => new Map()), classifyMaturity: jest.fn(() => null) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const CellarLayout = require('../models/CellarLayout');
const racksRouter = require('./racks');

const OWNER_ID = '64b000000000000000000001';
const EDITOR_ID = '64b000000000000000000002';
const VIEWER_ID = '64b000000000000000000003';
const STRANGER_ID = '64b000000000000000000004';
const RACK_ID = '64b0000000000000000000aa';
const OTHER_RACK_ID = '64b0000000000000000000ab';
const CELLAR_ID = '64b0000000000000000000bb';
const BOTTLE_ID = '64b0000000000000000000c1';

const token = (id) => jwt.sign({ id, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });

let server;
let port;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/racks', racksRouter);
  server = http.createServer(app);
  server.listen(0, () => { port = server.address().port; done(); });
});
afterAll((done) => { server.close(done); });

function call(method, url, body, as) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      port, path: url, method,
      headers: {
        Authorization: `Bearer ${token(as)}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// A 2x2 grid rack with a bottle in slot 1. Rack.findOne answers both an
// awaited query and the arrange preview's .populate(...) chain.
let racks;
function rackDoc(id) {
  const doc = {
    _id: id, cellar: CELLAR_ID, name: id === RACK_ID ? 'A' : 'B', group: null,
    type: 'grid', rows: 2, cols: 2, isModular: false, typeConfig: {},
    disabledPositions: [],
    zones: [],
    slots: id === RACK_ID ? [{ position: 1, bottle: BOTTLE_ID }] : [],
    deletedAt: null,
  };
  doc.save = jest.fn().mockResolvedValue(doc);
  doc.populate = jest.fn().mockResolvedValue(doc);
  doc.toObject = () => ({ ...doc });
  return doc;
}
function query(doc) {
  const p = Promise.resolve(doc);
  return { populate: jest.fn(() => p), then: (ok, ko) => p.then(ok, ko) };
}

const cellar = (over = {}) => ({
  _id: CELLAR_ID,
  user: OWNER_ID,
  members: [{ user: EDITOR_ID, role: 'editor' }, { user: VIEWER_ID, role: 'viewer' }],
  deletedAt: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  racks = { [RACK_ID]: rackDoc(RACK_ID), [OTHER_RACK_ID]: rackDoc(OTHER_RACK_ID) };
  Rack.findOne.mockImplementation((filter) => query(racks[String(filter._id)] || null));
  Cellar.findById.mockResolvedValue(cellar());
  CellarLayout.updateOne.mockResolvedValue({});
});

const SLOT_DENIED = 'Not authorized to modify rack slots';
// [label, method, url, body, the 403 message a viewer sees]
const ROUTES = [
  ['PUT /:id', 'PUT', `/api/racks/${RACK_ID}`, { name: 'Renamed' }, 'Not authorized to modify this rack'],
  ['DELETE /:id', 'DELETE', `/api/racks/${RACK_ID}`, null, 'Only the cellar owner can delete racks'],
  ['PUT /:id/slots/:position', 'PUT', `/api/racks/${RACK_ID}/slots/2`, { bottleId: BOTTLE_ID }, SLOT_DENIED],
  ['POST /:id/slots/:position/move', 'POST', `/api/racks/${RACK_ID}/slots/1/move`, { toPosition: 2 }, SLOT_DENIED],
  ['POST /:id/move-bottles', 'POST', `/api/racks/${RACK_ID}/move-bottles`, { toRackId: OTHER_RACK_ID }, SLOT_DENIED],
  ['POST /:id/arrange/preview', 'POST', `/api/racks/${RACK_ID}/arrange/preview`, { strategy: 'maturity' }, SLOT_DENIED],
  ['POST /:id/arrange/apply', 'POST', `/api/racks/${RACK_ID}/arrange/apply`, { target: [], before: [] }, SLOT_DENIED],
  ['DELETE /:id/slots/:position', 'DELETE', `/api/racks/${RACK_ID}/slots/1`, null, SLOT_DENIED],
  ['POST /:id/slots/:position/disable', 'POST', `/api/racks/${RACK_ID}/slots/2/disable`, null, SLOT_DENIED],
  ['DELETE /:id/slots/:position/disable', 'DELETE', `/api/racks/${RACK_ID}/slots/2/disable`, null, SLOT_DENIED],
];

const untouched = () => {
  expect(racks[RACK_ID].save).not.toHaveBeenCalled();
  expect(racks[OTHER_RACK_ID].save).not.toHaveBeenCalled();
};

describe('a caller with no role on the cellar', () => {
  test.each(ROUTES)('%s → 404 Rack not found', async (_label, method, url, body) => {
    const res = await call(method, url, body, STRANGER_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rack not found' });
    untouched();
  });
});

describe('a rack whose cellar is soft-deleted', () => {
  test.each(ROUTES)('%s → 404 Rack not found, even for the owner', async (_label, method, url, body) => {
    Cellar.findById.mockResolvedValue(cellar({ deletedAt: new Date() }));
    const res = await call(method, url, body, OWNER_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rack not found' });
    untouched();
  });
});

describe('a rack whose cellar is gone', () => {
  test.each(ROUTES)('%s → 404 Rack not found', async (_label, method, url, body) => {
    Cellar.findById.mockResolvedValue(null);
    const res = await call(method, url, body, OWNER_ID);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Rack not found' });
    untouched();
  });
});

describe('a member below the route role', () => {
  test.each(ROUTES)('%s → 403 for a viewer, with the route message', async (_label, method, url, body, message) => {
    const res = await call(method, url, body, VIEWER_ID);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: message });
    untouched();
  });

  test('DELETE /:id → 403 for an editor: only the owner deletes a rack', async () => {
    const res = await call('DELETE', `/api/racks/${RACK_ID}`, null, EDITOR_ID);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only the cellar owner can delete racks' });
    untouched();
  });
});

describe('members with the role still get through', () => {
  test('an editor disables a free slot', async () => {
    const res = await call('POST', `/api/racks/${RACK_ID}/slots/2/disable`, null, EDITOR_ID);
    expect(res.status).toBe(200);
    expect(racks[RACK_ID].disabledPositions).toEqual([2]);
    expect(racks[RACK_ID].save).toHaveBeenCalled();
  });

  test('the owner deletes the rack', async () => {
    const res = await call('DELETE', `/api/racks/${RACK_ID}`, null, OWNER_ID);
    expect(res.status).toBe(200);
    expect(racks[RACK_ID].deletedAt).toBeInstanceOf(Date);
  });
});
