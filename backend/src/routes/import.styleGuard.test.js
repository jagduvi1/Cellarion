/**
 * POST /api/bottles/import/validate — the styleConflict gate (issue #1134 at
 * import scale).
 *
 * The registry-first cascade auto-links at >= 0.95 through the raw scorer,
 * justified by the Pass 1a comment that findOrCreateWine "would auto-match
 * the same registry wine". Since the style guard landed in findOrCreateWine
 * that claim is only true if the cascade carries the same guard: a producer's
 * range pair with a long shared vineyard name measures 0.9538 (see
 * services/wineMatching.styleGuard.test.js), so without the gate a Trocken
 * import row files under its Halbtrocken sibling with status 'exact' — the
 * one status users are told needs no review.
 *
 * Locked here, with AI unconfigured (keyless self-host — the exact deployment
 * the post-release audit's failure scenario names):
 *   - a style-conflicting >= 0.95 top match does NOT auto-link: the row comes
 *     back 'fuzzy', with styleConflict carried on the match for the client's
 *     preselection guard (utils/importReview.autoSelectionsFor)
 *   - the same pair WITHOUT a style conflict still auto-links as 'exact' —
 *     the cascade itself is not blunted
 *
 * Harness cloned from import.validate.aiBudget.test.js: real router, real
 * auth, in-memory WineDefinition.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/priceWarnings', () => ({
  computeUserMediansByCurrency: jest.fn().mockResolvedValue({}),
}));
// Keyless install: the cascade and the fuzzy path are the whole pipeline.
jest.mock('../services/aiProvider', () => ({ isConfigured: () => false }));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/Bottle', () => function Bottle() {});
jest.mock('../models/WineRequest', () => function WineRequest() {});
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid'];
  return model;
});
jest.mock('../models/WineDefinition', () => {
  const state = { exactByKey: new Map(), candidates: [] };
  const chain = (docs) => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  const model = {
    findOne: jest.fn((filter) => ({
      populate: async () => {
        const keys = filter?.normalizedKey?.$in ?? [filter?.normalizedKey];
        for (const k of keys) {
          if (state.exactByKey.has(k)) return state.exactByKey.get(k);
        }
        return null;
      },
    })),
    find: jest.fn(() => chain(state.candidates)),
    findById: jest.fn(),
    __state: state,
  };
  return model;
});
jest.mock('../models/AiUsage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

const APPELLATION = 'Niederhäuser Hermannshöhle';
// The registry's row — one wine of a range.
const HALBTROCKEN = {
  _id: '64b0000000000000000000d1',
  name: 'Niederhäuser Hermannshöhle Riesling Großes Gewächs Alte Reben Erste Lage Halbtrocken',
  producer: 'Weingut Dönnhoff',
  appellation: APPELLATION,
  type: 'white',
  image: null,
  country: { name: 'Germany' },
  region: { name: 'Nahe' },
  normalizedKey: 'weingut donnhoff:niederhauser hermannshohle riesling groes gewachs alte reben erste lage halbtrocken:niederhauser hermannshohle',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return app;
}

function authToken() {
  return jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

function postJson(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${authToken()}`,
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
      req.write(payload);
      req.end();
    });
  });
}

const validate = (items) => postJson(buildApp(), '/api/bottles/import/validate', { cellarId: CELLAR_ID, items });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.__state.exactByKey.clear();
  WineDefinition.__state.candidates = [HALBTROCKEN];
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
});

describe('import cascade — styleConflict gate', () => {
  it('a style-conflicting >=0.95 sibling never auto-links as exact', async () => {
    const { status, body } = await validate([{
      wineName: 'Niederhäuser Hermannshöhle Riesling Großes Gewächs Alte Reben Erste Lage Trocken',
      producer: 'Weingut Dönnhoff',
      appellation: APPELLATION,
      country: 'Germany',
    }]);

    expect(status).toBe(200);
    const row = body.results[0];
    // 0.9538 clears the auto-link bar — only the gate keeps it a question.
    expect(row.status).toBe('fuzzy');
    expect(row.matches[0].wineId).toBe(HALBTROCKEN._id);
    expect(row.matches[0].score).toBeGreaterThanOrEqual(0.95);
    expect(row.matches[0].styleConflict).toMatch(/different sweetness/);
  });

  it('the same shape without a conflict still auto-links — the cascade is not blunted', async () => {
    const { status, body } = await validate([{
      // Halbtrocken row against the Halbtrocken registry wine, minor spelling
      // drift so the exact-key step misses and the fuzzy cascade decides.
      wineName: 'Niederhauser Hermannshohle Riesling Grosses Gewachs Alte Reben Erste Lage Halbtrocken',
      producer: 'Weingut Donnhoff',
      appellation: 'Niederhauser Hermannshohle',
      country: 'Germany',
    }]);

    expect(status).toBe(200);
    const row = body.results[0];
    expect(row.status).toBe('exact');
    expect(row.matches[0].wineId).toBe(HALBTROCKEN._id);
  });

  it('a fuzzy row carries styleConflict so the client can refuse to preselect it', async () => {
    const { body } = await validate([{
      // Below 0.95 (producer drifts further) — lands on the plain fuzzy path.
      wineName: 'Hermannshöhle Riesling GG Trocken',
      producer: 'Dönnhoff',
      appellation: APPELLATION,
      country: 'Germany',
    }]);

    const row = body.results[0];
    expect(row.status).toBe('fuzzy');
    const sibling = row.matches.find((m) => m.wineId === HALBTROCKEN._id);
    expect(sibling).toBeDefined();
    expect(sibling.styleConflict).toMatch(/different sweetness/);
  });
});
