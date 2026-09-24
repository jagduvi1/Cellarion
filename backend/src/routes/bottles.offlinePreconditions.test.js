/**
 * Offline-queue preconditions on the bottle routes (#1355). A write queued
 * offline says what the user saw; if the bottle changed meanwhile the route
 * answers 409 instead of overwriting someone else's change. Absent → the
 * routes behave exactly as before. Harness cloned from bottles.consumeDate.test.js.
 */
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../services/search', () => ({
  indexBottle: jest.fn(), removeBottle: jest.fn(), indexWine: jest.fn(),
  bulkIndexBottles: jest.fn(), getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined), reembedActiveVintages: jest.fn() }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockAlerts: jest.fn(), checkOnConsume: jest.fn(), checkRestockGap: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/rackOps', () => ({ moveBottleToCellar: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  addBottle: jest.fn(), validateBottleCommitFields: jest.fn(), updateBottleFields: jest.fn(), consumeBottle: jest.fn(),
  restoreBottle: jest.fn(), removeFromRacks: jest.fn(), removeBottleCascade: jest.fn(),
  openBottle: jest.fn(), pourFromBottle: jest.fn(), closeBottle: jest.fn(),
}));
jest.mock('../utils/exchangeRates', () => ({ getSnapshotForDate: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/PriceTrackingSkip', () => ({}));
jest.mock('../models/BottleImage', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), find: jest.fn() }));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { consumeBottle, openBottle, updateBottleFields } = require('../services/bottleOps');
const bottlesRouter = require('./bottles');

jest.setTimeout(20000);

const USER = '64b000000000000000000001';
const CELLAR = '64b0000000000000000000c1';
const BOTTLE = '64b0000000000000000000b1';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/bottles', bottlesRouter);
  return a;
}

function request(a, method, path, body) {
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const server = http.createServer(a);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path, method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

let bottleDoc;
beforeEach(() => {
  jest.clearAllMocks();
  bottleDoc = { _id: BOTTLE, cellar: CELLAR, status: 'active', vintage: '2019', notes: 'theirs', rating: 4, ratingScale: '5', populate: jest.fn(async () => {}) };
  Bottle.findById.mockImplementation(async () => bottleDoc);
  Cellar.findById.mockResolvedValue({ _id: CELLAR, user: USER, deletedAt: null, members: [] });
  consumeBottle.mockImplementation(async (b, opts) => ({ bottle: { _id: b._id, status: opts.reason } }));
  openBottle.mockImplementation(async (b, opts) => ({ bottle: { _id: b._id, openedAt: opts.openedAt || 'now' } }));
  updateBottleFields.mockImplementation(async () => ({}));
});

describe('consume — ifActive', () => {
  test('a bottle consumed elsewhere meanwhile is not consumed again', async () => {
    bottleDoc.status = 'drank';
    const res = await request(app(), 'POST', `/api/bottles/${BOTTLE}/consume`, { reason: 'drank', ifActive: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('state_changed');
    expect(consumeBottle).not.toHaveBeenCalled();
  });
  test('an active bottle is consumed', async () => {
    const res = await request(app(), 'POST', `/api/bottles/${BOTTLE}/consume`, { reason: 'drank', ifActive: true });
    expect(res.status).toBe(200);
    expect(consumeBottle).toHaveBeenCalledTimes(1);
  });
  test('without ifActive the old behaviour stands', async () => {
    bottleDoc.status = 'drank';
    const res = await request(app(), 'POST', `/api/bottles/${BOTTLE}/consume`, { reason: 'gifted' });
    expect(res.status).toBe(200);
  });
});

describe('open — openedAt', () => {
  test('the real time of opening reaches the service', async () => {
    const res = await request(app(), 'POST', `/api/bottles/${BOTTLE}/open`, { preservationMethod: 'coravin', openedAt: '2026-09-24T18:00:00Z' });
    expect(res.status).toBe(200);
    expect(openBottle.mock.calls[0][1]).toEqual({ preservationMethod: 'coravin', openedAt: '2026-09-24T18:00:00Z' });
  });
});

describe('edit — ifUnchanged', () => {
  test('a field changed elsewhere to something else is a conflict with the current value', async () => {
    const res = await request(app(), 'PUT', `/api/bottles/${BOTTLE}`, { notes: 'mine', ifUnchanged: { notes: 'what I saw' } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'field_changed', current: { notes: 'theirs' } });
    expect(updateBottleFields).not.toHaveBeenCalled();
  });
  test('unchanged since → applied, without the ifUnchanged key', async () => {
    const res = await request(app(), 'PUT', `/api/bottles/${BOTTLE}`, { notes: 'mine', rating: 5, ifUnchanged: { notes: 'theirs', rating: 4 } });
    expect(res.status).toBe(200);
    expect(updateBottleFields.mock.calls[0][1]).toEqual({ notes: 'mine', rating: 5 });
  });
  test('changed elsewhere to the very same value → no conflict', async () => {
    const res = await request(app(), 'PUT', `/api/bottles/${BOTTLE}`, { notes: 'theirs', ifUnchanged: { notes: 'old' } });
    expect(res.status).toBe(200);
  });
  test('an empty field on both sides counts as unchanged (null vs undefined)', async () => {
    bottleDoc.notes = undefined;
    const res = await request(app(), 'PUT', `/api/bottles/${BOTTLE}`, { notes: 'mine', ifUnchanged: { notes: null } });
    expect(res.status).toBe(200);
  });
  test('without ifUnchanged the old behaviour stands', async () => {
    const res = await request(app(), 'PUT', `/api/bottles/${BOTTLE}`, { notes: 'mine' });
    expect(res.status).toBe(200);
    expect(updateBottleFields).toHaveBeenCalledTimes(1);
  });
});
