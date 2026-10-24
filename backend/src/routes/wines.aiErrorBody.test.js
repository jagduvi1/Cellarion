/**
 * POST /api/wines/identify-text and /api/wines/ai-info — a 500 never carries
 * the thrown error's text.
 *
 * Both routes catch whatever the Anthropic layer throws (SDK, transport,
 * provider errors), and that text is not for the client: it reaches every
 * signed-in member. The body is the route's fixed message; the real error
 * stays in the server log, and the debit is still refunded.
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
  exists: jest.fn(async () => null),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const AiUsage = require('../models/AiUsage');
const rateLimitsConfig = require('../config/rateLimits');
const { todayUTC } = require('../services/aiBudget');
const { identifyWineFromQuery } = require('../services/labelScan');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const winesRouter = require('./wines');

const USER_ID = 'u1';
const PROVIDER_TEXT = 'provider-secret-text: 529 overloaded_error req_abc123';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wines', winesRouter);
  return app;
}

function token() {
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
            authorization: `Bearer ${token()}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, text, body: JSON.parse(text) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

const debits = (id) => AiUsage.__store.get(`${id}|${todayUTC()}`)?.count ?? 0;

let app;
let errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  AiUsage.__store.clear();
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
  app = buildApp();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe.each([
  ['/api/wines/identify-text', 'Failed to identify wine', 'Identify text error:'],
  ['/api/wines/ai-info', 'Failed to get AI wine info', 'AI info error:'],
])('POST %s — a thrown AI error', (url, literal, logLabel) => {
  test('answers 500 with the fixed message, never the error text', async () => {
    identifyWineFromQuery.mockRejectedValue(new Error(PROVIDER_TEXT));

    const res = await postJson(app, url, { query: 'penfolds bin 407' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: literal });
    expect(res.text).not.toContain('provider-secret-text');
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('keeps the real error in the server log', async () => {
    const err = new Error(PROVIDER_TEXT);
    identifyWineFromQuery.mockRejectedValue(err);

    await postJson(app, url, { query: 'penfolds bin 407' });

    expect(errorSpy).toHaveBeenCalledWith(logLabel, err);
  });

  test('still refunds the per-user and the site-wide debit', async () => {
    identifyWineFromQuery.mockRejectedValue(new Error(PROVIDER_TEXT));

    await postJson(app, url, { query: 'penfolds bin 407' });

    const refunds = AiUsage.findOneAndUpdate.mock.calls
      .filter(([, update]) => update.$inc.count === -1)
      .map(([filter]) => filter.userId);
    expect(refunds).toEqual([USER_ID, null]);
    expect(debits(USER_ID)).toBe(0);
    expect(debits(null)).toBe(0);
  });

  test('an error with no message answers the same fixed message', async () => {
    identifyWineFromQuery.mockRejectedValue(new Error(''));

    const res = await postJson(app, url, { query: 'penfolds bin 407' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: literal });
  });
});
