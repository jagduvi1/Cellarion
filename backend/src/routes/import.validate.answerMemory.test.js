/**
 * POST /api/bottles/import/validate — the answer memory (2026-09-25,
 * services/aiIdentificationCache).
 *
 * The same identification question asked again — a re-run import, a batch
 * retried after a timeout, another user's file — is answered for free. What
 * must hold, so adding bottles is never worse:
 *   1. a remembered answer costs no call and no debit, and the row resolves
 *      exactly as a fresh answer would;
 *   2. a fresh answer is offered to the memory; a refundable failure is not;
 *   3. the user's explicit "Look up" (forceAi) always asks afresh;
 *   4. remembered rows still resolve when the daily budget is spent — they are
 *      free — while unremembered rows degrade exactly as before.
 *
 * Harness mirrors import.validate.aiBudget.test.js: real router, real
 * requireAuth and aiBudget; models, the Anthropic layer and the memory mocked.
 */

process.env.JWT_SECRET = 'test-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/aiIdentificationCache', () => ({
  lookupIdentification: jest.fn(),
  rememberIdentification: jest.fn(),
}));
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
  return {
    findOne: jest.fn((filter) => ({
      populate: async () => {
        const keys = filter?.normalizedKey?.$in ?? [filter?.normalizedKey];
        for (const k of keys) {
          if (state.exactByKey.has(k)) return state.exactByKey.get(k);
        }
        return null;
      },
      select: () => ({ lean: async () => null }),
    })),
    find: jest.fn(() => chain(state.candidates)),
    findById: jest.fn(),
    __state: state,
  };
});
jest.mock('../models/AiUsage', () => {
  const store = new Map();
  return {
    findOneAndUpdate: jest.fn(async (filter, update) => {
      const k = `${filter.userId}|${filter.date}`;
      if (!store.has(k)) store.set(k, { userId: filter.userId, date: filter.date, count: 0 });
      const doc = store.get(k);
      if (update.$inc && typeof update.$inc.count === 'number') doc.count += update.$inc.count;
      return { ...doc };
    }),
    __store: store,
  };
});
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const AiUsage = require('../models/AiUsage');
const { identifyWineFromText } = require('../services/labelScan');
const { lookupIdentification, rememberIdentification } = require('../services/aiIdentificationCache');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const rateLimitsConfig = require('../config/rateLimits');
const { todayUTC } = require('../services/aiBudget');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';

function validate(items) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  const token = jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify({ cellarId: CELLAR_ID, items });
      const req = http.request({
        port: server.address().port,
        path: '/api/bottles/import/validate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

const userDebits = () => AiUsage.__store.get(`${USER_ID}|${todayUTC()}`)?.count ?? 0;
const identity = (name, producer) => ({
  data: { name, producer, country: 'France', type: 'red', grapes: [], confidence: 0.9 },
  debugRaw: 'raw',
  debugReason: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  AiUsage.__store.clear();
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: USER_ID, deletedAt: null, members: [] });
  lookupIdentification.mockResolvedValue(null);
  identifyWineFromText.mockImplementation(async ({ name, producer }) => identity(name, producer));
  findOrCreateWine.mockImplementation(async (wineData) => ({
    wine: {
      _id: `created-${wineData.name}`, name: wineData.name, producer: wineData.producer,
      appellation: null, type: 'red', image: null, country: { name: 'France' }, region: null,
    },
    created: true,
  }));
});

afterAll(() => {
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

const MYSTERY = { wineName: 'Mystery Cuvée', producer: 'Unknown Estate', vintage: '2020', country: 'France' };

test('a remembered answer resolves the row with no call and no debit', async () => {
  lookupIdentification.mockResolvedValue(identity('Mystery Cuvée', 'Unknown Estate'));

  const res = await validate([MYSTERY]);

  expect(res.status).toBe(200);
  expect(res.body.results[0].status).toBe('ai_match');
  expect(res.body.results[0].matches[0].aiIdentified).toBe(true);
  expect(identifyWineFromText).not.toHaveBeenCalled();
  expect(userDebits()).toBe(0);
  expect(lookupIdentification).toHaveBeenCalledWith({
    name: 'Mystery Cuvée', producer: 'Unknown Estate', vintage: '2020', country: 'France', appellation: undefined, region: undefined,
  });
});

test('a fresh answer is asked for, debited once, and offered to the memory', async () => {
  const res = await validate([MYSTERY]);

  expect(res.body.results[0].status).toBe('ai_match');
  expect(identifyWineFromText).toHaveBeenCalledTimes(1);
  expect(userDebits()).toBe(1);
  expect(rememberIdentification).toHaveBeenCalledTimes(1);
  expect(rememberIdentification.mock.calls[0][0]).toEqual(identifyWineFromText.mock.calls[0][0]);
  expect(rememberIdentification.mock.calls[0][1]).toEqual(identity('Mystery Cuvée', 'Unknown Estate'));
});

test('a refundable failure is refunded and not remembered', async () => {
  identifyWineFromText.mockResolvedValue({ data: null, debugRaw: 'boom', debugReason: 'exception: socket hang up' });

  const res = await validate([MYSTERY]);

  expect(res.body.results[0].status).toBe('no_match');
  expect(userDebits()).toBe(0);
  expect(rememberIdentification).not.toHaveBeenCalled();
});

test('"Look up" (forceAi) never reads the memory — it always asks afresh', async () => {
  lookupIdentification.mockResolvedValue(identity('Something Else', 'Elsewhere'));

  const res = await validate([{ ...MYSTERY, forceAi: true }]);

  expect(lookupIdentification).not.toHaveBeenCalled();
  expect(identifyWineFromText).toHaveBeenCalledTimes(1);
  expect(res.body.results[0].matches[0].name).toBe('Mystery Cuvée');
  expect(userDebits()).toBe(1);
});

test('with the daily budget spent, remembered rows still resolve and the rest degrade as before', async () => {
  rateLimitsConfig.set({ ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)), aiDailyBudget: { max: 1 } });
  AiUsage.__store.set(`${USER_ID}|${todayUTC()}`, { userId: USER_ID, date: todayUTC(), count: 1 });
  lookupIdentification.mockImplementation(async ({ name }) => (
    name === 'Remembered Red' ? identity('Remembered Red', 'Known Estate') : null
  ));

  const res = await validate([
    { wineName: 'Remembered Red', producer: 'Known Estate', vintage: '2019' },
    { wineName: 'Brand New White', producer: 'New Estate', vintage: '2021' },
  ]);

  expect(res.status).toBe(200);
  expect(identifyWineFromText).not.toHaveBeenCalled();
  const [remembered, fresh] = res.body.results;
  expect(remembered.status).toBe('ai_match');
  expect(remembered.aiSkipped).toBeUndefined();
  expect(fresh.aiSkipped).toBe(true);
  expect(fresh.status).toBe('no_match');
  expect(res.body.summary.aiBudgetExhausted).toBe(true);
});
