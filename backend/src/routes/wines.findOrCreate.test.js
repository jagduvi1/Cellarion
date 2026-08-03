/**
 * POST /api/wines/find-or-create — the registry-write chokepoint.
 *
 * Since identify-text became read-only, this is the ONLY user-facing path that
 * mints a WineDefinition, and it now receives machine-generated payloads (the
 * AI suggestion the user accepted, forwarded verbatim by AddBottle /
 * AddToWishlist). It had no route-level coverage at all; these tests pin the
 * guards and the provenance stamp.
 *
 * Real router; the service layer is mocked (no MongoDB).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({
  scanLabelFull: jest.fn(),
  identifyWineFromQuery: jest.fn(),
}));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
  exists: jest.fn(async () => ({ _id: 'demo1' })),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { submitUrls } = require('../services/indexNow');
const winesRouter = require('./wines');

const USER_ID = 'u1';

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

const VALID = { name: 'Bin 407', producer: 'Penfolds', country: 'Australia' };
const post = (body, jwtToken) => postJson(app, '/api/wines/find-or-create', body, jwtToken);

let app;

beforeEach(() => {
  jest.clearAllMocks();
  app = buildApp();
  findOrCreateWine.mockResolvedValue({ wine: { _id: 'w1', name: 'Bin 407', slug: 'bin-407' }, created: false });
});

describe('POST /api/wines/find-or-create — guards', () => {
  test('a demo JWT is rejected with 403 before the service is reached', async () => {
    const res = await post(VALID, token({ id: 'demo1', isDemo: true }));

    expect(res.status).toBe(403);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('missing country is a 400 — an AI suggestion with a null country cannot be accepted', async () => {
    const res = await post({ name: 'Bin 407', producer: 'Penfolds' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country/i);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('missing name or producer is a 400', async () => {
    expect((await post({ producer: 'Penfolds', country: 'Australia' })).status).toBe(400);
    expect((await post({ name: 'Bin 407', country: 'Australia' })).status).toBe(400);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('an over-long name or region is a 400 (region cap is new — findOrCreateRegion mints what arrives)', async () => {
    const long = 'x'.repeat(201);

    expect((await post({ ...VALID, name: long })).status).toBe(400);
    const regionRes = await post({ ...VALID, region: long });
    expect(regionRes.status).toBe(400);
    expect(regionRes.body.error).toMatch(/region/);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('a grapes array over 20 entries, or a non-array, is a 400', async () => {
    const many = [...Array(21).keys()].map(i => `Grape ${i}`);
    expect((await post({ ...VALID, grapes: many })).status).toBe(400);
    expect((await post({ ...VALID, grapes: 'Shiraz' })).status).toBe(400);
    expect((await post({ ...VALID, grapes: ['x'.repeat(201)] })).status).toBe(400);
    expect(findOrCreateWine).not.toHaveBeenCalled();

    // the boundary still passes through
    expect((await post({ ...VALID, grapes: [...Array(20).keys()].map(String) })).status).toBe(200);
  });
});

describe('POST /api/wines/find-or-create — behaviour', () => {
  test('a soft-zone result hands candidates back as 200 and creates nothing', async () => {
    findOrCreateWine.mockResolvedValue({ candidates: [{ wine: { _id: 'w9' }, score: 0.88 }] });

    const res = await post(VALID);

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].score).toBe(0.88);
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('a create returns 201 and pings IndexNow', async () => {
    findOrCreateWine.mockResolvedValue({ wine: { _id: 'w1', slug: 'bin-407' }, created: true });

    const res = await post(VALID);

    expect(res.status).toBe(201);
    expect(submitUrls).toHaveBeenCalledWith('/wines/bin-407');
  });

  test('confirmCreate also passes skipSiblingMatch — an explicit "create anyway" is not overridden by a sibling', async () => {
    await post({ ...VALID, confirmCreate: true });

    expect(findOrCreateWine.mock.calls[0][2]).toEqual({
      confirmCreate: true, skipSiblingMatch: true, createdVia: 'ui',
    });
  });

  test("source:'ai' stamps createdVia 'ai'; anything else falls back to 'ui'", async () => {
    // Provenance keeps the accepted-AI-suggestion cohort measurable after
    // identify-text stopped being the (unconfirmed) writer of createdVia:'ai'.
    await post({ ...VALID, source: 'ai' });
    expect(findOrCreateWine.mock.calls[0][2].createdVia).toBe('ai');

    jest.clearAllMocks();
    findOrCreateWine.mockResolvedValue({ wine: { _id: 'w1' }, created: false });

    await post({ ...VALID, source: 'totally-made-up' });
    expect(findOrCreateWine.mock.calls[0][2].createdVia).toBe('ui');

    jest.clearAllMocks();
    findOrCreateWine.mockResolvedValue({ wine: { _id: 'w1' }, created: false });

    await post(VALID);
    expect(findOrCreateWine.mock.calls[0][2].createdVia).toBe('ui');
  });
});
