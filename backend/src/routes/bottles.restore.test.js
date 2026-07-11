/**
 * POST /api/bottles/:id/restore — put a consumed bottle back to active.
 *
 * WHY THIS TEST EXISTS:
 * The inverse of /consume, for a drink/gift/sale logged by mistake. It must:
 *   - flip a consumed bottle back to 'active' and clear EVERY consumed-* field
 *   - reject an already-active bottle (400) so it can't wipe live data
 *   - be an editor-only action (requireBottleAccess('editor'))
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
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const searchService = require('../services/search');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const OTHER_ID = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000bb';
const BOTTLE_ID = '64b0000000000000000000dd';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return app;
}

function request(method, url, userId = USER_ID) {
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
            authorization: `Bearer ${jwt.sign({ id: userId, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
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

const restore = (userId) => request('POST', `/api/bottles/${BOTTLE_ID}/restore`, userId);

function makeBottle(overrides = {}) {
  return {
    _id: BOTTLE_ID,
    cellar: CELLAR_ID,
    user: USER_ID,
    vintage: '2018',
    status: 'drank',
    consumedAt: new Date('2026-07-11T11:07:00Z'),
    consumedReason: 'drank',
    consumedNote: 'oops',
    consumedRating: 4,
    consumedRatingScale: '5',
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    populate: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
});

describe('POST /api/bottles/:id/restore', () => {
  test('restores a drank bottle to active and clears every consumed field', async () => {
    const bottle = makeBottle();
    Bottle.findById.mockResolvedValue(bottle);

    const { status, body } = await restore();

    expect(status).toBe(200);
    expect(bottle.status).toBe('active');
    expect(bottle.consumedAt).toBeUndefined();
    expect(bottle.consumedReason).toBeUndefined();
    expect(bottle.consumedNote).toBeUndefined();
    expect(bottle.consumedRating).toBeUndefined();
    expect(bottle.consumedRatingScale).toBeUndefined();
    expect(bottle.save).toHaveBeenCalledTimes(1);
    expect(searchService.indexBottle).toHaveBeenCalledWith(bottle._id);
    expect(body.bottle.status).toBe('active');
  });

  test.each(['gifted', 'sold', 'other'])('restores a %s bottle too', async (reason) => {
    const bottle = makeBottle({ status: reason, consumedReason: reason });
    Bottle.findById.mockResolvedValue(bottle);

    const { status } = await restore();

    expect(status).toBe(200);
    expect(bottle.status).toBe('active');
  });

  test('rejects an already-active bottle (400) without saving', async () => {
    const bottle = makeBottle({ status: 'active', consumedAt: undefined, consumedReason: undefined });
    Bottle.findById.mockResolvedValue(bottle);

    const { status, body } = await restore();

    expect(status).toBe(400);
    expect(body.error).toMatch(/already active/i);
    expect(bottle.save).not.toHaveBeenCalled();
  });

  test('is editor-only: a non-member gets 403/404, bottle untouched', async () => {
    const bottle = makeBottle();
    Bottle.findById.mockResolvedValue(bottle);

    const { status } = await restore(OTHER_ID);

    expect([403, 404]).toContain(status);
    expect(bottle.save).not.toHaveBeenCalled();
    expect(bottle.status).toBe('drank');
  });
});
