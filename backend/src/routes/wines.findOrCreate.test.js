/**
 * POST /api/wines/find-or-create — the add flows' step-1 RESOLVE endpoint.
 *
 * This route used to be the registry-write chokepoint: it minted the
 * WineDefinition the moment the user confirmed the wine in step 1, before any
 * bottle existed — an abandoned flow left an orphan row forever (31 zero-bottle
 * createdVia:'ui' rows on prod, 2026-08-10; the "Domaine de Riquewihr —
 * Kaefferkopf" case). It is now RESOLVE-ONLY (matchOnly), the same shape as
 * identify-text (v1.97) and import /validate (#899): creation moved to the
 * bottle/wishlist commit (services/wineCommit, covered by its own suites).
 *
 * These tests pin the guards (unchanged), and the new no-write contract:
 * matchOnly always, never 201, never an audit or IndexNow ping, and a
 * confirmCreate in the body is ignored rather than becoming a create.
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
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
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
const { logAudit } = require('../services/audit');
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

  test('missing country is a 400 — an AI suggestion with a null country cannot be resolved', async () => {
    const res = await post({ name: 'Bin 407', producer: 'Penfolds' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country/i);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('missing name is a 400', async () => {
    expect((await post({ producer: 'Penfolds', country: 'Australia' })).status).toBe(400);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  // The add flows let a user leave the producer blank when the label is
  // unreadable, so step 1 must probe rather than refuse. This route still
  // creates nothing (matchOnly); the commit is what mints the pending row.
  test('a producerless payload is probed, not refused — producer reaches the service as a string', async () => {
    const res = await post({ name: 'Bin 407', country: 'Australia' });

    expect(res.status).toBe(200);
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    const [fields, , opts] = findOrCreateWine.mock.calls[0];
    // '' not undefined: the service .trim()s producer before consulting any
    // option, so a probe must never be the thing that 500s.
    expect(fields.producer).toBe('');
    expect(opts).toEqual({ matchOnly: true });
  });

  test('an over-long name or region is a 400 (region cap: findOrCreateRegion mints what arrives)', async () => {
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

describe('POST /api/wines/find-or-create — resolve-only behaviour', () => {
  test('resolves with matchOnly and NOTHING else — never a create option', async () => {
    await post(VALID);

    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    expect(findOrCreateWine.mock.calls[0][2]).toEqual({ matchOnly: true });
  });

  test('a confident match returns 200 { wine, created: false }', async () => {
    const res = await post(VALID);

    expect(res.status).toBe(200);
    expect(res.body.wine._id).toBe('w1');
    expect(res.body.created).toBe(false);
  });

  test('a soft-zone result hands candidates back as 200 and creates nothing', async () => {
    findOrCreateWine.mockResolvedValue({ wine: null, candidates: [{ wine: { _id: 'w9' }, score: 0.88 }] });

    const res = await post(VALID);

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].score).toBe(0.88);
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('no match returns 200 { wine: null, noMatch: true } — the client carries the fields to the commit', async () => {
    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });

    const res = await post(VALID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wine: null, created: false, noMatch: true });
  });

  test('confirmCreate in the body is IGNORED — no create, no skipSiblingMatch, still matchOnly', async () => {
    // A stale client (or a crafted request) asking to create must get a
    // resolve, never a mint: the only mint points are the commit endpoints.
    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });

    const res = await post({ ...VALID, confirmCreate: true, source: 'ai' });

    expect(res.status).toBe(200);
    expect(res.body.noMatch).toBe(true);
    expect(findOrCreateWine.mock.calls[0][2]).toEqual({ matchOnly: true });
  });

  test('never audits wine.create and never pings IndexNow — this route writes nothing', async () => {
    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
    await post(VALID);
    await post({ ...VALID, confirmCreate: true });

    expect(logAudit).not.toHaveBeenCalled();
    expect(submitUrls).not.toHaveBeenCalled();
  });
});
