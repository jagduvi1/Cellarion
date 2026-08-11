/**
 * GET /api/wines/:id + GET /api/wines — regional grape display decoration
 * (somm ticket: "Tinta Roriz stored as Tempranillo on a Douro Port").
 *
 * WHY THIS TEST EXISTS:
 * Wines keep referencing ONE canonical Grape doc; the read surfaces resolve
 * the regionally correct label per wine (utils/grapeDisplay). These tests pin
 * that the wine routes actually apply the decoration: every populated grape
 * gains `displayName` (region entry wins, canonical fallback) and `name`
 * stays the canonical variety — the contract the frontend's
 * `g.displayName || g.name` rendering rests on.
 *
 * Real router + real requireAuth (HS256 test token); models and side-effect
 * services are mocked so no MongoDB is needed.
 */
process.env.JWT_SECRET = 'test-secret';

// services/search eagerly requires the ESM-only `meilisearch` package, which
// Jest can't transform — stub it (matches the repo's unit-test style).
jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
}));
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/imageSanitizer', () => ({
  sanitizeImageBuffer: jest.fn(),
  detectImageFormat: jest.fn(),
}));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineMatching', () => ({ findBestMatch: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/communityPrice', () => ({ getReleaseCurve: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn().mockResolvedValue({ ok: true, refund: jest.fn() }),
  isRefundableFailure: jest.fn().mockReturnValue(false),
  isRefundableScanError: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../models/WineDefinition');
const winesRouter = require('./wines');

const USER_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000cc';
const PORTUGAL = 'a'.repeat(24);
const DOURO = 'b'.repeat(24);

// Thenable query stub: supports the .populate()/.select()/.sort()/.limit()/
// .skip() chains the routes use, resolving to `result` when awaited.
const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

const wineDoc = () => ({
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
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wines', winesRouter);
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

beforeEach(() => jest.clearAllMocks());

describe('GET /api/wines/:id', () => {
  test('grapes carry displayName resolved against the wine\'s own country/region; name stays canonical', async () => {
    WineDefinition.findById.mockReturnValue(chain(wineDoc()));
    const { status, body } = await get(`/api/wines/${WINE_ID}`);
    expect(status).toBe(200);
    expect(body.wine.grapes[0].displayName).toBe('Tinta Roriz');
    expect(body.wine.grapes[0].name).toBe('Tempranillo');
    // Unmapped grape falls back to canonical — the frontend renders
    // displayName || name, so it must never be missing-and-misleading.
    expect(body.wine.grapes[1].displayName).toBe('Touriga Nacional');
  });
});

describe('GET /api/wines (list)', () => {
  test('the Mongo list path decorates every wine\'s grapes', async () => {
    WineDefinition.find.mockReturnValue(chain([wineDoc()]));
    WineDefinition.countDocuments.mockResolvedValue(1);
    const { status, body } = await get('/api/wines?search=port');
    expect(status).toBe(200);
    expect(body.wines).toHaveLength(1);
    expect(body.wines[0].grapes[0].displayName).toBe('Tinta Roriz');
    expect(body.wines[0].grapes[0].name).toBe('Tempranillo');
  });
});

describe('GET /api/wines/:idOrSlug/public', () => {
  test('the public wine page gets the same decoration (no auth required)', async () => {
    WineDefinition.findOne.mockReturnValue(chain(wineDoc()));
    const { status, body } = await get(`/api/wines/${WINE_ID}/public`);
    expect(status).toBe(200);
    expect(body.wine.grapes[0].displayName).toBe('Tinta Roriz');
  });
});
