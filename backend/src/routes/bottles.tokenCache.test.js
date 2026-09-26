/**
 * GET /api/bottles — answering API-token polling from memory.
 *
 * Scaling audit 2026-09-25: Home Assistant asks `?maturity=…&limit=…` every
 * few minutes and after every change nudge, and the maturity path loads and
 * classifies the whole collection per request. Pinned here: a token request
 * with an unchanged data version is answered from memory; a change (the data
 * version), another query or the max age recomputes; browser requests (no API
 * token) are never cached — they show fresh photos.
 *
 * requireAuth is stubbed so a test can mark a request as token-authenticated;
 * models and side-effect services are mocked.
 */

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: req.headers['x-user'], roles: ['user'] };
    if (req.headers['x-token'] === '1') req.apiToken = { id: 'tok', scopes: ['read'] };
    next();
  },
  requireNonDemo: (req, res, next) => next(),
}));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }), indexBottle: jest.fn(), removeBottle: jest.fn() }));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockGap: jest.fn(), resolveRestockAlerts: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn(), getSnapshotForDate: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
jest.mock('../utils/maturityUtils', () => ({
  ...jest.requireActual('../utils/maturityUtils'),
  buildProfileMap: jest.fn().mockResolvedValue(new Map()),
  classifyMaturity: jest.fn(() => 'peak'),
}));
jest.mock('./cellars', () => ({ attachBottleImageUrls: async (bottles) => bottles }));

jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({}));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn() }));

const express = require('express');
const http = require('http');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { bumpDataVersion } = require('../services/dataVersion');
const bottlesRouter = require('./bottles');

function get(url, { user, token }) {
  const app = express();
  app.use('/api/bottles', bottlesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: url, method: 'GET',
        headers: { 'x-user': user, ...(token ? { 'x-token': '1' } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

let loads;
beforeEach(() => {
  jest.clearAllMocks();
  loads = 0;
  Cellar.find.mockReturnValue({ distinct: jest.fn().mockResolvedValue(['64b0000000000000000000bb']) });
  Bottle.find.mockImplementation(() => {
    loads += 1;
    const n = loads;
    const chain = {
      populate: () => chain, sort: () => chain, skip: () => chain, limit: () => chain,
      lean: async () => [{ _id: `b${n}`, vintage: '2015', createdAt: new Date(), wineDefinition: { name: `load ${n}` } }],
    };
    return chain;
  });
});

const POLL = '/api/bottles?maturity=peak,late&limit=50';
const nameOf = (res) => res.body.bottles.items[0].wineDefinition.name;

test('an unchanged token poll is answered from memory — the collection is not reloaded', async () => {
  const u = 'user-a';
  const first = await get(POLL, { user: u, token: true });
  const second = await get(POLL, { user: u, token: true });
  expect(first.status).toBe(200);
  expect(nameOf(second)).toBe('load 1');
  expect(loads).toBe(1);
});

test('a change (the data version moves) brings a fresh answer', async () => {
  const u = 'user-b';
  await get(POLL, { user: u, token: true });
  bumpDataVersion(u);
  expect(nameOf(await get(POLL, { user: u, token: true }))).toBe('load 2');
});

test('another query is another answer; another user never shares one', async () => {
  await get(POLL, { user: 'user-c', token: true });
  expect(nameOf(await get('/api/bottles?maturity=peak&limit=20', { user: 'user-c', token: true }))).toBe('load 2');
  expect(nameOf(await get(POLL, { user: 'user-d', token: true }))).toBe('load 3');
});

test('browser requests (no API token) are never cached', async () => {
  await get(POLL, { user: 'user-e', token: false });
  expect(nameOf(await get(POLL, { user: 'user-e', token: false }))).toBe('load 2');
});

test('an answer older than the max age is recomputed', async () => {
  const u = 'user-f';
  await get(POLL, { user: u, token: true });
  const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
  try {
    expect(nameOf(await get(POLL, { user: u, token: true }))).toBe('load 2');
  } finally {
    spy.mockRestore();
  }
});
