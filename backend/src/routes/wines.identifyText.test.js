/**
 * POST /api/wines/identify-text is READ-ONLY.
 *
 * It used to call findOrCreateWine unconditionally, minting a WineDefinition
 * for every AI guess before the user confirmed anything — 52% of the rows it
 * produced on prod never received a bottle. These tests pin the two properties
 * that keep it honest: it probes with `{ matchOnly: true }` and nothing else,
 * and its response carries no saved wine.
 *
 * The budget half matters just as much. The old handler wrapped everything in
 * one try/catch that refunded on ANY throw, so a soft-zone probe (which crashed
 * on `wine.toObject` when wine was null) both 500'd and reversed a completed,
 * billable call — including its draw on the site-wide kill switch. The
 * phase-1/phase-2 split is asserted here shape by shape.
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

// `exists` is required, not optional: requireAuth calls User.exists({ _id, isDemo: true })
// for a demo token, and without it the TypeError is swallowed into a 401 "Invalid
// token" — which would let the demo test below pass while proving nothing.
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
  exists: jest.fn(async () => ({ _id: 'demo1' })),
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
const DEMO_ID = 'demo1';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/wines', winesRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });
  return app;
}

function token({ id = USER_ID, isDemo = false } = {}) {
  return jwt.sign({ id, roles: ['user'], ...(isDemo ? { isDemo: true } : {}) },
    'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

function postJson(app, url, body, jwtToken = token()) {
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
            authorization: `Bearer ${jwtToken}`,
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
      req.end(payload);
    });
  });
}

const userDebits = (id = USER_ID) => AiUsage.__store.get(`${id}|${todayUTC()}`)?.count ?? 0;

const IDENTIFIED = {
  name: 'Bin 407',
  producer: 'Penfolds',
  country: 'Australia',
  region: 'South Australia',
  appellation: null,
  type: 'red',
  grapes: ['Cabernet Sauvignon'],
  confidence: 0.7,
};

function aiReturns(data) {
  identifyWineFromQuery.mockResolvedValue({ data, debugRaw: 'raw', debugReason: null });
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  AiUsage.__store.clear();
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
  app = buildApp();
  // Safe default AFTER the clear: an un-stubbed test exercises no-match on
  // purpose instead of crashing on undefined inside the route.
  findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
  aiReturns({ ...IDENTIFIED });
});

afterAll(() => {
  rateLimitsConfig.set(JSON.parse(JSON.stringify(rateLimitsConfig.defaults)));
});

describe('POST /api/wines/identify-text — never creates', () => {
  test('probes with exactly { matchOnly: true } and never passes createdVia', async () => {
    await postJson(app, '/api/wines/identify-text', { query: 'penfolds bin 407' });

    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    // toEqual, NOT objectContaining: objectContaining would also pass
    // { matchOnly: true, confirmCreate: true }, which silently collapses the
    // soft zone (the candidate return sits above the matchOnly gate) and
    // reproduces the duplication this route was changed to stop.
    expect(findOrCreateWine.mock.calls[0][2]).toEqual({ matchOnly: true });
    expect(findOrCreateWine.mock.calls[0][2]).not.toHaveProperty('createdVia');
  });

  test('a confident match returns the registry wine and no top-level wine/created', async () => {
    findOrCreateWine.mockResolvedValue({ wine: { _id: 'w1', name: 'Bin 407', producer: 'Penfolds' } });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'penfolds bin 407' });

    expect(res.status).toBe(200);
    expect(res.body.match.wine._id).toBe('w1');
    expect(res.body.candidates).toEqual([]);
    expect(res.body.reason).toBeNull();
    expect(res.body.identified.name).toBe('Bin 407');
    expect(res.body).not.toHaveProperty('wine');
    expect(res.body).not.toHaveProperty('created');
  });

  test('a soft-zone probe returns 200 with candidates — never a 500 — and stays debited', async () => {
    // Against the pre-fix route this failed with 500 and userDebits() === 0:
    // the handler destructured `wine` from this shape and called wine.toObject.
    findOrCreateWine.mockResolvedValue({
      wine: null,
      candidates: [{ wine: { _id: 'w9', name: 'Bin 407' }, score: 0.9 }],
    });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'penfolds bin 407' });

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].score).toBe(0.9);
    expect(res.body.match).toBeNull();
    expect(userDebits()).toBe(1);
  });

  test('a noMatch probe reports identified-but-not-in-registry', async () => {
    const res = await postJson(app, '/api/wines/identify-text', { query: 'penfolds bin 407' });

    expect(res.status).toBe(200);
    expect(res.body.identified.producer).toBe('Penfolds');
    expect(res.body.match).toBeNull();
    expect(res.body.candidates).toEqual([]);
    expect(res.body.reason).toBeNull();
  });
});

describe('POST /api/wines/identify-text — budget accounting', () => {
  test('a DB failure in the probe returns 500 and STAYS debited', async () => {
    // The completed Anthropic call was paid for. The old blanket catch refunded
    // here, reversing both the per-user row and the global kill switch.
    findOrCreateWine.mockRejectedValue(new Error('Mongo down'));

    const res = await postJson(app, '/api/wines/identify-text', { query: 'penfolds bin 407' });

    expect(res.status).toBe(500);
    expect(userDebits()).toBe(1);
  });

  test('a transport failure before the probe still refunds and never probes', async () => {
    identifyWineFromQuery.mockResolvedValue({ data: null, debugRaw: 'x', debugReason: 'exception: boom' });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'whatever' });

    expect(res.status).toBe(200);
    expect(res.body.identified).toBeNull();
    expect(res.body.reason).toBe('exception: boom');
    expect(userDebits()).toBe(0);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('an ai_unknown completion stays debited and never probes', async () => {
    identifyWineFromQuery.mockResolvedValue({ data: null, debugRaw: 'x', debugReason: 'ai_unknown: no idea' });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'whatever' });

    expect(res.status).toBe(200);
    expect(userDebits()).toBe(1);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });
});

describe('POST /api/wines/identify-text — model output is normalized before the probe', () => {
  test('a non-string name is reported as unidentified, stays debited, and never probes', async () => {
    // findOrCreateWine .trim()s name/producer before consulting any option, so
    // this would throw inside the probe without the route-level normalize.
    aiReturns({ name: 42, producer: 'Penfolds', country: 'Australia', grapes: [] });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'x' });

    expect(res.status).toBe(200);
    expect(res.body.identified).toBeNull();
    expect(res.body.reason).toBe('invalid_identity_fields');
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(userDebits()).toBe(1);
  });

  test('over-long fields are capped, junk types dropped and grapes bounded', async () => {
    aiReturns({
      name: 'N'.repeat(500),
      producer: '  Penfolds   Estate  ',
      country: 'Australia',
      region: '',
      appellation: null,
      type: 'orange',
      grapes: [...Array(40).keys()].map(i => `Grape ${i}`).concat([null, 7, '']),
      confidence: 4.2,
    });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'x' });

    const id = res.body.identified;
    expect(id.name).toHaveLength(200);
    expect(id.producer).toBe('Penfolds Estate'); // whitespace collapsed
    expect(id.region).toBeNull();                // empty string → null
    expect(id.type).toBeNull();                  // not a registry wine type
    expect(id.grapes).toHaveLength(20);          // capped, non-strings dropped
    expect(id.confidence).toBe(1);               // clamped into [0,1]
    // and the probe receives the cleaned payload, not the raw model output
    expect(findOrCreateWine.mock.calls[0][0].producer).toBe('Penfolds Estate');
  });
});

describe('POST /api/wines/identify-text — regional grape display parity', () => {
  // Audit 2026-08-11 INFO: the AI-identify card renders next to the search
  // list, which already shows the regional label ("Tinta Roriz" on a Douro
  // row) — the identify response must be decorated the same way.
  const DOURO_WINE = {
    _id: 'w1',
    name: 'Vintage Port',
    producer: 'Quinta do Exemplo',
    country: { _id: 'pt1', name: 'Portugal' },
    region: { _id: 'douro1', name: 'Douro' },
    grapes: [{
      _id: 'g1',
      name: 'Tempranillo',
      regionalNames: [{ country: 'pt1', region: 'douro1', name: 'Tinta Roriz' }],
    }],
  };

  test('a confident match carries displayName on its grapes; name stays canonical', async () => {
    findOrCreateWine.mockResolvedValue({ wine: DOURO_WINE });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'quinta do exemplo vintage port' });

    expect(res.status).toBe(200);
    expect(res.body.match.wine.grapes[0].displayName).toBe('Tinta Roriz');
    expect(res.body.match.wine.grapes[0].name).toBe('Tempranillo');
  });

  test('soft-zone candidates are decorated too, scores untouched', async () => {
    findOrCreateWine.mockResolvedValue({
      wine: null,
      candidates: [{ wine: DOURO_WINE, score: 0.9 }],
    });

    const res = await postJson(app, '/api/wines/identify-text', { query: 'quinta do exemplo vintage port' });

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].wine.grapes[0].displayName).toBe('Tinta Roriz');
    expect(res.body.candidates[0].score).toBe(0.9);
  });
});

describe('POST /api/wines/identify-text — demo accounts', () => {
  test('a demo JWT gets 403 demo_ai_disabled before Claude and before any probe', async () => {
    const res = await postJson(app, '/api/wines/identify-text', { query: 'penfolds bin 407' },
      token({ id: DEMO_ID, isDemo: true }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('demo_ai_disabled');
    expect(identifyWineFromQuery).not.toHaveBeenCalled();
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(userDebits(DEMO_ID)).toBe(0);
  });
});
