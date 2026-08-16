/**
 * POST /api/bottles/import/validate — post-AI geography hygiene
 * (ticket 6a8162c5: the 226-row batch that split one producer across region
 * granularities and across countries).
 *
 * Two behaviours pinned, both applied to aiIdentified BEFORE matching so the
 * preview, the aiProposed payload and the /confirm mint all agree:
 *
 *   A) One producer, one country per batch. Per-row identification let an
 *      obscure producer come back as South Africa on one row and Australia on
 *      another; both minted, and the different-country guard then kept them
 *      apart forever. Rows whose FILE stated a country anchor the group and
 *      are never overwritten.
 *
 *   B) Geography identified below AI_GEOGRAPHY_MIN_CONFIDENCE (0.6) is
 *      dropped (region/appellation → null): "reasonably sure" is the band
 *      that wrote the producer's home region onto wines from elsewhere
 *      (Sister's Run "Epiphany", a McLaren Vale Shiraz recorded as Barossa).
 *      Country is kept — a wine cannot mint without one, and the same
 *      producer-consistency pass above governs it.
 */

process.env.JWT_SECRET = 'test-secret';

// AI is CONFIGURED in this suite — the hygiene pass only runs on AI results.
jest.mock('../services/aiProvider', () => ({ isConfigured: () => true }));
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn().mockResolvedValue({ ok: true, refund: jest.fn() }),
  isRefundableFailure: jest.fn(() => false),
}));

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
jest.mock('../models/Country', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
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
jest.mock('../models/WineDefinition', () => {
  const chain = (docs) => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => docs };
    return c;
  };
  return {
    findOne: jest.fn(() => ({ populate: async () => null })),
    find: jest.fn(() => chain([])),
    findById: jest.fn(),
  };
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const { identifyWineFromText } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const rateLimitsConfig = require('../config/rateLimits');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

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

/** identifyWineFromText result for one row (echoes name/producer like the real prompt). */
const aiResult = (over = {}) => ({
  data: {
    name: over.name, producer: over.producer,
    country: 'Australia', region: null, appellation: null,
    type: 'red', grapes: [], confidence: 0.9,
    ...over,
  },
  debugRaw: 'raw', debugReason: null,
});

/** Dispatch AI results by wine name — the identify calls run concurrently, so
 *  mockResolvedValueOnce ordering would be a race. */
const primeAi = (...results) => {
  const byName = new Map(results.map((r) => [r.data.name, r]));
  identifyWineFromText.mockImplementation(async ({ name }) => byName.get(name));
};

beforeAll(() => {
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
  // Registry knows nothing → every AI identification comes back aiProposed.
  findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
});

describe('B) confidence floor on AI geography', () => {
  test('region/appellation identified below 0.6 are stripped from aiProposed', async () => {
    primeAi(aiResult({
      name: 'Epiphany', producer: "Sister's Run",
      region: 'Barossa Valley', appellation: 'Barossa Valley', confidence: 0.5,
    }));

    const res = await validate([{ wineName: 'Epiphany', producer: "Sister's Run", vintage: '2021' }]);

    expect(res.status).toBe(200);
    const row = res.body.results[0];
    expect(row.status).toBe('ai_new');
    expect(row.aiProposed.region).toBeNull();
    expect(row.aiProposed.appellation).toBeNull();
    // Country survives the floor — a wine cannot mint without one.
    expect(row.aiProposed.country).toBe('Australia');
    // And the matcher saw the stripped shape too, not just the response.
    expect(findOrCreateWine.mock.calls[0][0].region).toBeNull();
    expect(findOrCreateWine.mock.calls[0][0].appellation).toBeNull();
  });

  test('a missing/non-numeric confidence strips too — unknown means nobody can vouch', async () => {
    primeAi(aiResult({
      name: 'Ghost Block', producer: 'Phantom Estate',
      region: 'Hunter Valley', appellation: 'Hunter Valley', confidence: undefined,
    }));

    const res = await validate([{ wineName: 'Ghost Block', producer: 'Phantom Estate' }]);
    expect(res.body.results[0].aiProposed.region).toBeNull();
    expect(res.body.results[0].aiProposed.appellation).toBeNull();
  });

  test('at or above 0.6 the identified geography is kept', async () => {
    primeAi(aiResult({
      name: 'Vat 9', producer: "Tyrrell's",
      region: 'Hunter Valley', appellation: 'Hunter Valley', confidence: 0.6,
    }));

    const res = await validate([{ wineName: 'Vat 9', producer: "Tyrrell's" }]);
    expect(res.body.results[0].aiProposed.region).toBe('Hunter Valley');
    expect(res.body.results[0].aiProposed.appellation).toBe('Hunter Valley');
  });
});

describe('A) one producer, one country per batch', () => {
  test('two AI-guessed countries for one producer unify to the higher-confidence row', async () => {
    primeAi(
      aiResult({ name: 'Mistura', producer: 'Thomas Allen', country: 'South Africa', confidence: 0.5 }),
      aiResult({ name: 'Origins', producer: 'Thomas Allen', country: 'Australia', confidence: 0.7 }));

    const res = await validate([
      { wineName: 'Mistura', producer: 'Thomas Allen' },
      { wineName: 'Origins', producer: 'Thomas Allen' },
    ]);

    const [a, b] = res.body.results;
    expect(a.aiProposed.country).toBe('Australia');
    expect(b.aiProposed.country).toBe('Australia');
  });

  test('rows whose FILE stated a country anchor the group and are never overwritten', async () => {
    primeAi(
      aiResult({ name: 'Mistura', producer: 'Thomas Allen', country: 'South Africa', confidence: 0.9 }),
      aiResult({ name: 'Origins', producer: 'Thomas Allen', country: 'Australia', confidence: 0.5 }));

    // Row 2's country came from the import file itself — it anchors.
    const res = await validate([
      { wineName: 'Mistura', producer: 'Thomas Allen' },
      { wineName: 'Origins', producer: 'Thomas Allen', country: 'Australia' },
    ]);

    const [a, b] = res.body.results;
    expect(b.aiProposed.country).toBe('Australia');  // anchor untouched
    expect(a.aiProposed.country).toBe('Australia');  // free row adopts the anchor
  });

  test('a row the AI left countryless inherits the group country instead of failing to mint', async () => {
    primeAi(
      aiResult({ name: 'Vat 9', producer: "Tyrrell's", country: 'Australia', confidence: 0.9 }),
      aiResult({ name: 'Vat 47', producer: "Tyrrell's", country: null, confidence: 0.7 }));

    const res = await validate([
      { wineName: 'Vat 9', producer: "Tyrrell's" },
      { wineName: 'Vat 47', producer: "Tyrrell's" },
    ]);

    expect(res.body.results[1].aiProposed.country).toBe('Australia');
  });

  test('two file-backed countries for one producer are real information — nothing is touched', async () => {
    primeAi(
      aiResult({ name: 'Mistura', producer: 'Thomas Allen', country: 'South Africa', confidence: 0.9 }),
      aiResult({ name: 'Origins', producer: 'Thomas Allen', country: 'Australia', confidence: 0.9 }));

    const res = await validate([
      { wineName: 'Mistura', producer: 'Thomas Allen', country: 'South Africa' },
      { wineName: 'Origins', producer: 'Thomas Allen', country: 'Australia' },
    ]);

    expect(res.body.results[0].aiProposed.country).toBe('South Africa');
    expect(res.body.results[1].aiProposed.country).toBe('Australia');
  });
});
