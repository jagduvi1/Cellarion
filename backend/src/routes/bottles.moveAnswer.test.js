/**
 * POST /api/bottles/:id/move — what it answers by caller, and what it refuses
 * as a destination, without a database. An API token gets the bottle with its
 * wine as an id (the public contract, openapi/document.js MoveResponse); a
 * session gets the wine populated for the bottle page. A destination that is
 * not an id string is a 400, never a crash. openapi/contract.test.js checks
 * the token answer on a real database.
 */
const express = require('express');
const http = require('http');

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: '64b000000000000000000001', roles: ['user'] };
    if (req.headers['x-as-token']) req.apiToken = { id: '64b0000000000000000000cc', scopes: ['write'] };
    next();
  },
  requireNonDemo: (req, res, next) => next(),
}));
jest.mock('../services/search', () => ({ indexWine: jest.fn(), getIsAvailable: jest.fn(() => false) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined), reembedActiveVintages: jest.fn() }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockAlerts: jest.fn(), checkOnConsume: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/rackOps', () => ({ moveBottleToCellar: jest.fn() }));
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
const { moveBottleToCellar } = require('../services/rackOps');
// Loaded here, not inside a test: the router is the heaviest module in the
// tree, and requiring it inside the first test's budget times out under a
// parallel suite run.
const bottlesRouter = require('./bottles');

jest.setTimeout(20000);

const USER = '64b000000000000000000001';
const SRC = '64b0000000000000000000c1';
const DEST = '64b0000000000000000000d1';
const BOTTLE = '64b0000000000000000000b1';
const WINE = '64b0000000000000000000e1';

function post(body, { asToken = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: `/api/bottles/${BOTTLE}/move`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(asToken ? { 'x-as-token': '1' } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

let bottle;
beforeEach(() => {
  jest.clearAllMocks();
  bottle = {
    _id: BOTTLE, cellar: SRC, status: 'active',
    // The service leaves the wine populated with its name, for its audit row.
    wineDefinition: { _id: WINE, name: 'Château Exemple' },
    depopulate: jest.fn(function depopulate() { this.wineDefinition = WINE; return this; }),
    populate: jest.fn(async function populate() { this.wineDefinition = { _id: WINE, name: 'Château Exemple', producer: 'Château Exemple' }; return this; }),
  };
  Bottle.findById.mockResolvedValue(bottle);
  Cellar.findById.mockResolvedValue({ _id: SRC, user: USER, name: 'Storage', deletedAt: null, members: [] });
  Cellar.findOne.mockResolvedValue({ _id: DEST, user: USER, name: 'Home', deletedAt: null, members: [] });
  moveBottleToCellar.mockResolvedValue({ bottle, from: { cellarId: SRC, cellarName: 'Storage' } });
});

describe('POST /api/bottles/:id/move — the answer, by caller', () => {
  test('a token gets the bottle with its wine as an id, and the full wine is never loaded', async () => {
    const res = await post({ toCellarId: DEST }, { asToken: true });
    expect(res.status).toBe(200);
    expect(res.body.bottle.wineDefinition).toBe(WINE);
    expect(bottle.depopulate).toHaveBeenCalledWith('wineDefinition');
    expect(bottle.populate).not.toHaveBeenCalled();
  });

  test('a session gets the bottle with its wine populated', async () => {
    const res = await post({ toCellarId: DEST });
    expect(res.status).toBe(200);
    expect(res.body.bottle.wineDefinition).toMatchObject({ _id: WINE, producer: 'Château Exemple' });
    expect(bottle.populate).toHaveBeenCalledTimes(1);
    expect(bottle.depopulate).not.toHaveBeenCalled();
  });
});

describe('POST /api/bottles/:id/move — the destination must be an id string', () => {
  test.each([
    ['a number', 12345],
    ['an object carrying an id', { id: 'a'.repeat(24) }],
    ['a query operator', { $ne: null }],
    ['an array', ['a'.repeat(24)]],
    ['text that is not an id', 'attic'],
    ['nothing', undefined],
  ])('%s answers 400 and looks nothing up', async (_, toCellarId) => {
    const res = await post({ toCellarId }, { asToken: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid destination cellar');
    expect(Cellar.findOne).not.toHaveBeenCalled();
    expect(moveBottleToCellar).not.toHaveBeenCalled();
  });
});
