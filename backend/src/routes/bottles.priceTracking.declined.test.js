/**
 * Price-tracking request routes × sommelier declines (PriceTrackingSkip).
 *
 * WHY THIS TEST EXISTS:
 * Declining a price request (POST /api/somm/prices/requests/:id/decline or
 * the reject_price_request MCP tool) records a PriceTrackingSkip for the
 * wine+vintage pair. That skip must actually SUPPRESS re-queueing here:
 *   - POST /api/bottles/:id/request-price-tracking → 409 with the curator's
 *     reason surfaced, and NO request document is created or touched
 *   - GET  /api/bottles/:id/request-price-tracking → eligible:false (+
 *     declined:true) so the request toggle disappears instead of inviting a
 *     dead-end click
 *   - a pair WITHOUT a skip keeps working exactly as before
 *
 * Real router + real requireAuth/requireBottleAccess (HS256 test tokens);
 * models and side-effect services are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexBottle: jest.fn(),
  removeBottle: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({
  checkRestockGap: jest.fn().mockResolvedValue(null),
  resolveRestockAlerts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  getSnapshotForDate: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc);
    this.save = jest.fn().mockResolvedValue(this);
  });
  M.findOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingSkip', () => ({ findOne: jest.fn() }));
jest.mock('../models/BottleImage', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const BOTTLE_ID = '64b0000000000000000000dd';
const WINE_ID = '64b0000000000000000000ee';

// Chainable query mock (only .lean() is used by these routes).
const chain = (result) => ({
  select: jest.fn(function () { return this; }),
  lean: jest.fn(() => Promise.resolve(result)),
  then: (res, rej) => Promise.resolve(result).then(res, rej),
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return app;
}

function request(method, url) {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method,
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  Bottle.findById.mockResolvedValue({
    _id: BOTTLE_ID,
    cellar: CELLAR_ID,
    user: USER_ID,
    status: 'active',
    wineDefinition: WINE_ID,
    vintage: '2018',
  });
});

describe('POST /api/bottles/:id/request-price-tracking with a declined pair', () => {
  test('refuses with 409 and surfaces the curator reason; no request doc is created or touched', async () => {
    PriceTrackingSkip.findOne.mockReturnValue(chain({
      wineDefinition: WINE_ID, vintage: '2018', reason: 'Everyday retail wine — no secondary market.',
    }));

    const { status, body } = await request('POST', `/api/bottles/${BOTTLE_ID}/request-price-tracking`);

    expect(status).toBe(409);
    expect(body.error).toMatch(/declined price tracking: Everyday retail wine — no secondary market\./);
    expect(PriceTrackingRequest.findOne).not.toHaveBeenCalled();
    expect(PriceTrackingRequest).not.toHaveBeenCalled(); // constructor never invoked
  });

  test('a reason-less legacy skip still refuses, with the generic message', async () => {
    PriceTrackingSkip.findOne.mockReturnValue(chain({ wineDefinition: WINE_ID, vintage: '2018' }));
    const { status, body } = await request('POST', `/api/bottles/${BOTTLE_ID}/request-price-tracking`);
    expect(status).toBe(409);
    expect(body.error).toMatch(/declined price tracking\./);
  });

  test('no skip → the request flow works exactly as before', async () => {
    PriceTrackingSkip.findOne.mockReturnValue(chain(null));
    PriceTrackingRequest.findOne.mockResolvedValue(null);

    const { status, body } = await request('POST', `/api/bottles/${BOTTLE_ID}/request-price-tracking`);

    expect(status).toBe(200);
    expect(body.requested).toBe(true);
    expect(body.requesterCount).toBe(1);
    expect(PriceTrackingRequest).toHaveBeenCalledTimes(1); // singleton created
  });
});

describe('GET /api/bottles/:id/request-price-tracking with a declined pair', () => {
  test('reports the pair as ineligible (declined:true) so the toggle disappears', async () => {
    PriceTrackingSkip.findOne.mockReturnValue(chain({ _id: 'sk1' }));

    const { status, body } = await request('GET', `/api/bottles/${BOTTLE_ID}/request-price-tracking`);

    expect(status).toBe(200);
    expect(body).toEqual({ requested: false, requesterCount: 0, eligible: false, declined: true });
    expect(PriceTrackingRequest.findOne).not.toHaveBeenCalled();
  });

  test('no skip → status keeps its pre-decline shape (eligible, not requested)', async () => {
    PriceTrackingSkip.findOne.mockReturnValue(chain(null));
    PriceTrackingRequest.findOne.mockReturnValue(chain(null));

    const { status, body } = await request('GET', `/api/bottles/${BOTTLE_ID}/request-price-tracking`);

    expect(status).toBe(200);
    expect(body).toEqual({ requested: false, requesterCount: 0, eligible: true });
  });
});
