/**
 * POST /api/bottles + PUT /api/bottles/:id — personal drink window fields.
 *
 * WHY THIS TEST EXISTS:
 * drinkFrom/drinkTo are the user's own per-bottle drink window (integer years
 * 1900–2200, from <= to). Unlike the import pipeline (which drops invalid
 * values silently), the interactive bottle routes must answer 400 when an
 * explicitly provided value is invalid — including a PARTIAL update whose new
 * value would invert the window against the bottle's stored other half.
 * Bottles without the fields must behave exactly as before (additive).
 *
 * Real router + real requireAuth/requireBottleAccess (HS256 test tokens);
 * models and side-effect services are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

// services/search eagerly requires the ESM-only `meilisearch` package — stub.
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

// ── Model mocks ──────────────────────────────────────────────────────────────

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

jest.mock('../models/Bottle', () => {
  const instances = [];
  function Bottle(data) {
    Object.assign(this, data);
    this._id = `bottle-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Bottle.__instances = instances;
  Bottle.findById = jest.fn();
  return Bottle;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';
const BOTTLE_ID = '64b0000000000000000000dd';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return app;
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body !== undefined ? JSON.stringify(body) : null;
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
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
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const create = (body) => request(buildApp(), 'POST', '/api/bottles', body);
const update = (body) => request(buildApp(), 'PUT', `/api/bottles/${BOTTLE_ID}`, body);

let storedBottle;

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  WineDefinition.findById.mockResolvedValue({ _id: WINE_ID, name: 'Test Wine' });
  // Existing bottle for PUT — carries a stored window half for the
  // partial-update inversion checks.
  storedBottle = {
    _id: BOTTLE_ID,
    cellar: CELLAR_ID,
    user: USER_ID,
    vintage: '2018',
    ratingScale: '5',
    drinkFrom: 2020,
    drinkTo: 2040,
    save: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    populate: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
  };
  Bottle.findById.mockResolvedValue(storedBottle);
});

// ── POST /api/bottles ────────────────────────────────────────────────────────

describe('POST /api/bottles drink window', () => {
  const base = { cellar: CELLAR_ID, wineDefinition: WINE_ID, vintage: '2018' };

  test('creates without the fields exactly as before (additive regression)', async () => {
    const { status } = await create(base);
    expect(status).toBe(201);
    expect(Bottle.__instances).toHaveLength(1);
    expect(Bottle.__instances[0].drinkFrom).toBeUndefined();
    expect(Bottle.__instances[0].drinkTo).toBeUndefined();
  });

  test('accepts a valid window', async () => {
    const { status, body } = await create({ ...base, drinkFrom: 2022, drinkTo: 2035 });
    expect(status).toBe(201);
    expect(Bottle.__instances[0].drinkFrom).toBe(2022);
    expect(Bottle.__instances[0].drinkTo).toBe(2035);
    expect(body.bottle.drinkFrom).toBe(2022);
  });

  test('accepts a single-sided window', async () => {
    const { status } = await create({ ...base, drinkTo: 2035 });
    expect(status).toBe(201);
    expect(Bottle.__instances[0].drinkFrom).toBeUndefined();
    expect(Bottle.__instances[0].drinkTo).toBe(2035);
  });

  test('400 when drinkFrom is after drinkTo', async () => {
    const { status, body } = await create({ ...base, drinkFrom: 2040, drinkTo: 2020 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/drinkFrom cannot be after drinkTo/);
    expect(Bottle.__instances).toHaveLength(0);
  });

  test('400 on out-of-range or non-integer years', async () => {
    expect((await create({ ...base, drinkFrom: 1899 })).status).toBe(400);
    expect((await create({ ...base, drinkTo: 9999 })).status).toBe(400);
    expect((await create({ ...base, drinkFrom: 2020.5 })).status).toBe(400);
    expect((await create({ ...base, drinkTo: 'soonish' })).status).toBe(400);
    expect(Bottle.__instances).toHaveLength(0);
  });
});

// ── PUT /api/bottles/:id ─────────────────────────────────────────────────────

describe('PUT /api/bottles/:id drink window', () => {
  test('updates both fields', async () => {
    const { status } = await update({ drinkFrom: 2025, drinkTo: 2045 });
    expect(status).toBe(200);
    expect(storedBottle.drinkFrom).toBe(2025);
    expect(storedBottle.drinkTo).toBe(2045);
    expect(storedBottle.save).toHaveBeenCalled();
  });

  test('update without the fields leaves the stored window untouched (additive regression)', async () => {
    const { status } = await update({ notes: 'just a note' });
    expect(status).toBe(200);
    expect(storedBottle.drinkFrom).toBe(2020);
    expect(storedBottle.drinkTo).toBe(2040);
  });

  test('clears the window with nulls', async () => {
    const { status } = await update({ drinkFrom: null, drinkTo: null });
    expect(status).toBe(200);
    expect(storedBottle.drinkFrom).toBeNull();
    expect(storedBottle.drinkTo).toBeNull();
  });

  test('400 when the provided pair is inverted', async () => {
    const { status, body } = await update({ drinkFrom: 2045, drinkTo: 2025 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/drinkFrom cannot be after drinkTo/);
    expect(storedBottle.save).not.toHaveBeenCalled();
  });

  test('400 when a partial update inverts the window against the stored half', async () => {
    // stored drinkFrom = 2020 — new drinkTo before it
    expect((await update({ drinkTo: 2010 })).status).toBe(400);
    // stored drinkTo = 2040 — new drinkFrom after it
    expect((await update({ drinkFrom: 2050 })).status).toBe(400);
    expect(storedBottle.save).not.toHaveBeenCalled();
  });

  test('partial update passes when the stored other half was cleared first', async () => {
    storedBottle.drinkFrom = null;
    const { status } = await update({ drinkTo: 2010 });
    expect(status).toBe(200);
    expect(storedBottle.drinkTo).toBe(2010);
  });

  test('400 on out-of-range years', async () => {
    expect((await update({ drinkFrom: 1001 })).status).toBe(400);
    expect((await update({ drinkTo: 9999 })).status).toBe(400);
    expect(storedBottle.save).not.toHaveBeenCalled();
  });
});
