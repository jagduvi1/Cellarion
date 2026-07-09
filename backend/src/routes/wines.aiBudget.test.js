/**
 * Shared daily AI budget on the Anthropic-backed wine endpoints
 * (SECURITY_AUDIT_2026-07-08 L-14): scan-label / identify-text / ai-info.
 *
 * Unlike the import pipeline (which degrades to fuzzy matching), these
 * endpoints have no non-AI fallback — over budget they must return
 * 429 { code: 'ai_budget_exhausted' } with a Retry-After pointing at the
 * next UTC midnight, without ever reaching rembg or Claude. Successful calls
 * debit once; transport failures refund.
 *
 * Real router + real aiBudget service; AiUsage and the Anthropic layer are
 * mocked (no MongoDB).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
}));
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());

// In-memory AiUsage so the REAL debit/refund logic runs without Mongo.
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

// The REAL aiBudget service now checks User.aiBudgetOverride (admin-granted
// temporary budget increases) — resolve "no override" so the base budget
// applies. Override behaviour itself is covered by services/aiBudget.test.js.
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const AiUsage = require('../models/AiUsage');
const rateLimitsConfig = require('../config/rateLimits');
const { todayUTC } = require('../services/aiBudget');
const { scanLabelFull, identifyWineFromQuery } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const winesRouter = require('./wines');

sharp.cache(false);

const USER_ID = 'u1';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/wines', winesRouter);
  return app;
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
            authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

const userDebits = () => AiUsage.__store.get(`${USER_ID}|${todayUTC()}`)?.count ?? 0;

function setLimits(overrides = {}) {
  rateLimitsConfig.set({
    ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)),
    ...overrides,
  });
}

function exhaustUserBudget(max) {
  setLimits({ aiDailyBudget: { max } });
  AiUsage.__store.set(`${USER_ID}|${todayUTC()}`, { userId: USER_ID, date: todayUTC(), count: max });
}

let app;
const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  AiUsage.__store.clear();
  setLimits();
  app = buildApp();
  // rembg unreachable — scan-label falls back to the sanitized original
  global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
});

afterEach(() => {
  global.fetch = realFetch;
});

afterAll(() => {
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

describe('POST /api/wines/scan-label — daily AI budget', () => {
  async function validImage() {
    const buf = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 30, b: 40 } },
    }).png().toBuffer();
    return buf.toString('base64');
  }

  test('over budget → 429 ai_budget_exhausted with Retry-After, before rembg or Claude', async () => {
    exhaustUserBudget(3);

    const res = await postJson(app, '/api/wines/scan-label', { image: await validImage() });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ai_budget_exhausted');
    expect(res.body.scope).toBe('user_budget');
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
    expect(Number(res.headers['retry-after'])).toBe(res.body.retryAfterSeconds);
    expect(global.fetch).not.toHaveBeenCalled();      // never reached rembg
    expect(scanLabelFull).not.toHaveBeenCalled();     // never reached Claude
    expect(userDebits()).toBe(3);                     // overshoot refunded
  });

  test('within budget: the scan debits exactly once', async () => {
    // No producer → the route skips the registry-match block (which would
    // need MongoDB); this test is about the budget debit only.
    scanLabelFull.mockResolvedValue({ name: 'Wine', producer: null, grapes: [] });

    const res = await postJson(app, '/api/wines/scan-label', { image: await validImage() });

    expect(res.status).toBe(200);
    expect(scanLabelFull).toHaveBeenCalledTimes(1);
    expect(userDebits()).toBe(1);
  });

  test('a failed scan refunds the debit', async () => {
    const err = new Error('Could not read label');
    err.status = 422;
    scanLabelFull.mockRejectedValue(err);

    const res = await postJson(app, '/api/wines/scan-label', { image: await validImage() });

    expect(res.status).toBe(422);
    expect(userDebits()).toBe(0);
  });
});

describe('POST /api/wines/identify-text — daily AI budget', () => {
  test('over budget → 429 ai_budget_exhausted, Claude never called', async () => {
    exhaustUserBudget(5);

    const res = await postJson(app, '/api/wines/identify-text', { query: 'Albert Bichot Fixin 2019' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ai_budget_exhausted');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(identifyWineFromQuery).not.toHaveBeenCalled();
  });

  test('global kill-switch tripped → 429 with global_cap scope, user debit refunded', async () => {
    setLimits({ aiGlobalDailyCap: { max: 10 } });
    AiUsage.__store.set(`null|${todayUTC()}`, { userId: null, date: todayUTC(), count: 10 });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'anything' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ai_budget_exhausted');
    expect(res.body.scope).toBe('global_cap');
    expect(userDebits()).toBe(0); // user debit rolled back when the global cap tripped
    expect(identifyWineFromQuery).not.toHaveBeenCalled();
  });

  test('successful identify debits once', async () => {
    identifyWineFromQuery.mockResolvedValue({
      data: { name: 'Fixin', producer: 'Albert Bichot', country: 'France', grapes: [] },
      debugRaw: 'raw',
      debugReason: null,
    });
    findOrCreateWine.mockResolvedValue({ wine: { _id: 'w1', name: 'Fixin', producer: 'Albert Bichot' }, created: true });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'Albert Bichot Fixin 2019' });

    expect(res.status).toBe(200);
    expect(res.body.wine.name).toBe('Fixin');
    expect(userDebits()).toBe(1);
  });

  test('a transport failure refunds; an ai_unknown answer stays debited', async () => {
    identifyWineFromQuery.mockResolvedValueOnce({ data: null, debugRaw: 'x', debugReason: 'exception: boom' });
    let res = await postJson(app, '/api/wines/identify-text', { query: 'whatever' });
    expect(res.status).toBe(200);
    expect(res.body.wine).toBeNull();
    expect(userDebits()).toBe(0); // refunded

    identifyWineFromQuery.mockResolvedValueOnce({ data: null, debugRaw: 'x', debugReason: 'ai_unknown: no idea' });
    res = await postJson(app, '/api/wines/identify-text', { query: 'whatever' });
    expect(res.status).toBe(200);
    expect(userDebits()).toBe(1); // a completed Anthropic call — kept
  });
});

describe('POST /api/wines/ai-info — daily AI budget', () => {
  test('over budget → 429 ai_budget_exhausted', async () => {
    exhaustUserBudget(2);

    const res = await postJson(app, '/api/wines/ai-info', { query: 'Chateau Margaux 2015' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ai_budget_exhausted');
    expect(identifyWineFromQuery).not.toHaveBeenCalled();
  });

  test('within budget: debits once and returns the AI data', async () => {
    identifyWineFromQuery.mockResolvedValue({
      data: { name: 'Château Margaux', producer: 'Château Margaux', country: 'France', grapes: [] },
      debugRaw: 'raw',
      debugReason: null,
    });

    const res = await postJson(app, '/api/wines/ai-info', { query: 'Chateau Margaux 2015' });

    expect(res.status).toBe(200);
    expect(res.body.wine.name).toBe('Château Margaux');
    expect(userDebits()).toBe(1);
  });
});
