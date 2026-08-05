/**
 * POST /api/bottles/import/validate — no-AI installs share the registry-first
 * cascade (audit 2026-08-03 H3).
 *
 * WHY THIS TEST EXISTS: `uniquePrs` (the dedup-by-wine-key list driving the
 * Pass 1a registry cascade) used to be built only when aiProvider
 * .isConfigured() — an explicitly supported self-hosted mode is running with
 * NO AI key, and for those installs every row fell through to Pass 3's
 * sequential per-row findWineMatches with zero dedup: a 2000-row import of a
 * mixed case cost one lookup PER ROW instead of per unique wine, slow enough
 * to hit the shipped 120s nginx proxy_read_timeout. This pins: with no AI
 * key, the cascade still runs once per unique wine key and its outcome is
 * shared across duplicate rows; only the AI fan-out itself stays gated.
 */

process.env.JWT_SECRET = 'test-secret';

// The one behavioural switch under test: AI is NOT configured.
jest.mock('../services/aiProvider', () => ({ isConfigured: () => false }));

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

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({}));
jest.mock('../models/Bottle', () => function Bottle() {});
jest.mock('../models/WineRequest', () => function WineRequest() {});
jest.mock('../models/AiUsage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => {
  const model = { find: jest.fn() };
  model.RACK_TYPES = ['grid'];
  return model;
});

// Registry mock: exact normalizedKey lookups + the MongoDB fallback candidate
// searches used by findWineMatches ($text, normalizedKey regex).
jest.mock('../models/WineDefinition', () => {
  const state = { exactByKey: new Map(), candidates: [] };
  const chain = (docs) => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  const model = {
    findOne: jest.fn((filter) => ({
      populate: async () => state.exactByKey.get(filter?.normalizedKey) ?? null,
    })),
    find: jest.fn(() => chain(state.candidates)),
    findById: jest.fn(),
    __state: state,
  };
  return model;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const { identifyWineFromText } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

const LA_TACHE = {
  _id: '64b0000000000000000000c1',
  name: 'La Tâche',
  producer: 'Domaine de la Romanée-Conti',
  appellation: null,
  type: 'red',
  image: null,
  country: { name: 'France' },
  region: { name: 'Burgundy' },
  normalizedKey: 'domaine de la romaneeconti:la tache:',
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
  WineDefinition.__state.candidates = [];
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
});

test('an exact registry wine resolves as "exact" via the cascade — not per-row fuzzy', async () => {
  WineDefinition.__state.exactByKey.set(LA_TACHE.normalizedKey, LA_TACHE);

  const res = await validate([
    { wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018' },
  ]);

  expect(res.status).toBe(200);
  expect(res.body.results[0].status).toBe('exact');
  expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
  expect(res.body.results[0].aiSkipped).toBeUndefined(); // full-quality outcome, not degradation
  expect(identifyWineFromText).not.toHaveBeenCalled();
  expect(findOrCreateWine).not.toHaveBeenCalled();
});

test('duplicate rows of one wine share ONE cascade lookup (the H3 per-row explosion)', async () => {
  const row = { wineName: 'Mystery Cuvée', producer: 'Unknown Estate' };
  const res = await validate([
    { ...row, vintage: '2019' },
    { ...row, vintage: '2020' },
    { ...row, vintage: '2021' },
  ]);

  expect(res.status).toBe(200);
  for (const r of res.body.results) expect(r.status).toBe('no_match');

  // The exact-key probe runs once per UNIQUE wine key (raw + prefix-stripped
  // variants ≤ 2 findOne calls), not once per row.
  expect(WineDefinition.findOne.mock.calls.length).toBeLessThanOrEqual(2);
  // findWineMatches (2 fallback `find` strategies with Meili unavailable) runs
  // once for the unique key and is REUSED by the other rows: 2 calls, not 6.
  expect(WineDefinition.find).toHaveBeenCalledTimes(2);
});

test('exact-scoring fuzzy candidates short-circuit to "exact" shared across rows', async () => {
  WineDefinition.__state.candidates = [LA_TACHE];

  const row = { wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti' };
  const res = await validate([{ ...row, vintage: '2018' }, { ...row, vintage: '2019' }]);

  for (const r of res.body.results) {
    expect(r.status).toBe('exact');
    expect(r.matches[0].wineId).toBe(LA_TACHE._id);
    expect(r.matches[0].score).toBeGreaterThanOrEqual(0.95);
  }
  // One shared cascade run: candidates fetched once, not once per row.
  expect(WineDefinition.find).toHaveBeenCalledTimes(2);
});

test('forceAi rows fall back to the shared cascade when there is no AI to force', async () => {
  WineDefinition.__state.exactByKey.set(LA_TACHE.normalizedKey, LA_TACHE);

  const res = await validate([
    { wineName: 'La Tâche', producer: 'Domaine de la Romanée-Conti', vintage: '2018', forceAi: true },
  ]);

  expect(res.body.results[0].status).toBe('exact');
  expect(res.body.results[0].matches[0].wineId).toBe(LA_TACHE._id);
  expect(identifyWineFromText).not.toHaveBeenCalled();
});

test('no-AI responses carry no degradation markers (aiSkipped / aiBudgetExhausted / aiDebug)', async () => {
  const res = await validate([{ wineName: 'Ghost', producer: 'Phantom', vintage: '2020' }]);

  expect(res.status).toBe(200);
  expect(res.body.results[0].status).toBe('no_match');
  expect(res.body.results[0].aiSkipped).toBeUndefined();
  expect(res.body.results[0].aiDebug).toBeUndefined();
  expect(res.body.summary.aiBudgetExhausted).toBeUndefined();
});
