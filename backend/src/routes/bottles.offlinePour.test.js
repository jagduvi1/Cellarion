/**
 * POST /api/bottles/:id/pour with the offline queue's expectPours. The route
 * hands the glasses the user saw to the service and passes the refusal's code
 * back, so the device can list the pour under "needs attention" instead of
 * adding the glass twice. Harness cloned from bottles.offlinePreconditions.test.js.
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
const { pourFromBottle } = require('../services/bottleOps');
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

function post(a, path, body) {
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const server = http.createServer(a);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path, method: 'POST',
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
  bottleDoc = { _id: BOTTLE, cellar: CELLAR, status: 'active', openedAt: new Date(), pours: [], populate: jest.fn(async () => {}) };
  Bottle.findById.mockImplementation(async () => bottleDoc);
  Cellar.findById.mockResolvedValue({ _id: CELLAR, user: USER, deletedAt: null, members: [] });
  pourFromBottle.mockImplementation(async (b) => ({ bottle: { _id: b._id, pours: [{ ml: 125 }] } }));
});

describe('pour — expectPours', () => {
  test('the glasses the user saw reach the service with the ml', async () => {
    const res = await post(app(), `/api/bottles/${BOTTLE}/pour`, { ml: 150, expectPours: 2 });
    expect(res.status).toBe(200);
    expect(pourFromBottle.mock.calls[0][1]).toEqual({ ml: 150, expectPours: 2 });
  });

  test('a refusal keeps its code, so the device can tell "poured meanwhile" apart', async () => {
    pourFromBottle.mockResolvedValue({ error: { status: 409, message: 'Glasses were poured from this bottle meanwhile', code: 'state_changed' } });
    const res = await post(app(), `/api/bottles/${BOTTLE}/pour`, { ml: 125, expectPours: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Glasses were poured from this bottle meanwhile', code: 'state_changed' });
  });

  test('without expectPours the pour button behaves as before', async () => {
    const res = await post(app(), `/api/bottles/${BOTTLE}/pour`, { ml: 125 });
    expect(res.status).toBe(200);
    expect(pourFromBottle.mock.calls[0][1]).toEqual({ ml: 125, expectPours: undefined });
  });

  test('an error without a code answers with the message alone', async () => {
    pourFromBottle.mockResolvedValue({ error: { status: 400, message: 'Too many pours recorded for this bottle' } });
    const res = await post(app(), `/api/bottles/${BOTTLE}/pour`, {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Too many pours recorded for this bottle' });
  });
});
