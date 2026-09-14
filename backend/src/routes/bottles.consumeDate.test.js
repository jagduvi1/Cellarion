/**
 * POST /api/bottles/:id/consume — the day the bottle was actually drunk.
 *
 * Support ticket 2026-09-13: "when I remove a bottle that was drunk, the
 * consumed date is set as the current date — how do I set it properly?" The
 * bulk action had taken `consumedAt` since v1.200; the single-bottle route
 * did not forward it, so the modal could not offer a date. This pins the
 * pass-through (the validation itself lives in services/bottleOps and is
 * tested there). Harness cloned from bottles.bulk.test.js.
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
const { consumeBottle } = require('../services/bottleOps');
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

function postJson(a, path, body) {
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const payload = JSON.stringify(body);
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

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.findById.mockResolvedValue({ _id: BOTTLE, cellar: CELLAR, status: 'active', vintage: '2019' });
  Cellar.findById.mockResolvedValue({ _id: CELLAR, user: USER, deletedAt: null, members: [] });
  consumeBottle.mockImplementation(async (bottle, opts) => ({ bottle: { ...bottle, status: opts.reason, consumedAt: opts.consumedAt || 'now' } }));
});

test('consumedAt from the body reaches the shared service', async () => {
  const res = await postJson(app(), `/api/bottles/${BOTTLE}/consume`, { reason: 'drank', consumedAt: '2026-09-06' });

  expect(res.status).toBe(200);
  expect(consumeBottle).toHaveBeenCalledTimes(1);
  expect(consumeBottle.mock.calls[0][1]).toEqual({
    reason: 'drank', note: undefined, rating: undefined, ratingScale: undefined, consumedAt: '2026-09-06',
  });
  expect(res.body.bottle.consumedAt).toBe('2026-09-06');
});

test('without consumedAt the service still stamps "now" (unchanged default)', async () => {
  const res = await postJson(app(), `/api/bottles/${BOTTLE}/consume`, { reason: 'gifted', note: 'birthday' });

  expect(res.status).toBe(200);
  expect(consumeBottle.mock.calls[0][1]).toMatchObject({ reason: 'gifted', note: 'birthday' });
  expect(consumeBottle.mock.calls[0][1].consumedAt).toBeUndefined();
});

test('the service\'s date refusal surfaces as its 400', async () => {
  consumeBottle.mockResolvedValue({ error: { status: 400, message: 'consumedAt must be a valid date and not in the future' } });
  const res = await postJson(app(), `/api/bottles/${BOTTLE}/consume`, { reason: 'drank', consumedAt: '2999-01-01' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/not in the future/);
});
