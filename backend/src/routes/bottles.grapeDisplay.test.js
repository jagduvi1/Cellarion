/**
 * GET /api/bottles/:id — regional grape display decoration on the bottle page
 * (somm ticket: "Tinta Roriz stored as Tempranillo on a Douro Port").
 *
 * WHY THIS TEST EXISTS:
 * The bottle detail response serializes the populated wineDefinition; each
 * grape must gain `displayName` resolved against the WINE's own
 * country/region while `name` stays the canonical variety — the contract the
 * bottle page's grape pills (`g.displayName || g.name`) rest on. Storage is
 * untouched: the bottle still references the canonical Grape doc.
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
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
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
jest.mock('../models/BottleImage', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';
const BOTTLE_ID = '64b0000000000000000000dd';
const PORTUGAL = 'a'.repeat(24);
const DOURO = 'b'.repeat(24);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return app;
}

function get(url) {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'GET',
          headers: {
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

let storedBottle;

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  // No pending/default images in this suite.
  BottleImage.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
  BottleImage.findById.mockReturnValue({ lean: async () => null });

  const wineDefinition = {
    _id: WINE_ID,
    name: 'Vintage Port',
    producer: 'Quinta do Exemplo',
    type: 'fortified',
    country: { _id: PORTUGAL, name: 'Portugal' },
    region: { _id: DOURO, name: 'Douro' },
    grapes: [
      { _id: 'c'.repeat(24), name: 'Tempranillo', regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }] },
      { _id: 'd'.repeat(24), name: 'Touriga Nacional' },
    ],
  };
  storedBottle = {
    _id: BOTTLE_ID,
    cellar: CELLAR_ID,
    vintage: '2017',
    wineDefinition,
    populate: jest.fn().mockImplementation(function () { return Promise.resolve(this); }),
    toObject() {
      return { _id: this._id, cellar: this.cellar, vintage: this.vintage, wineDefinition: this.wineDefinition };
    },
  };
  Bottle.findById.mockResolvedValue(storedBottle);
});

describe('GET /api/bottles/:id', () => {
  test('wineDefinition grapes carry displayName for the wine\'s place; name stays canonical', async () => {
    const { status, body } = await get(`/api/bottles/${BOTTLE_ID}`);
    expect(status).toBe(200);
    const grapes = body.bottle.wineDefinition.grapes;
    expect(grapes[0].displayName).toBe('Tinta Roriz');
    expect(grapes[0].name).toBe('Tempranillo');
    expect(grapes[1].displayName).toBe('Touriga Nacional');
  });

  test('the stored bottle object is not mutated by decoration (canonical stays canonical in memory)', async () => {
    await get(`/api/bottles/${BOTTLE_ID}`);
    // The doc the rest of the app sees (indexing, audit) keeps canonical-only
    // grapes — decoration happens on the serialized copy.
    expect(storedBottle.wineDefinition.grapes[0].displayName).toBeUndefined();
  });
});
