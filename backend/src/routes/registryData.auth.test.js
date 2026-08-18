/**
 * Auth-matrix tests for /api/registry-data and /api/admin/registry-data
 * (#985 Slice B), in the personalData.auth.test.js style.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));

const express = require('express');
const http = require('http');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const registryDataRouter = require('./registryData');
const adminRegistryDataRouter = require('./admin/registryData');

const shape = (router) => router.stack
  .filter((l) => l.route)
  .map((l) => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods).map((m) => m.toUpperCase()),
    handlers: l.route.stack.map((s) => s.handle),
  }));

describe('registry-data router shape', () => {
  const routes = shape(registryDataRouter);

  test('drift canary', () => {
    expect(routes.map((r) => `${r.methods.join(',')} ${r.path}`).sort()).toEqual([
      'GET /keys', 'GET /wine/:id', 'POST /keys', 'POST /wine/:id',
    ]);
  });

  test('requireAuth guards the router; writes carry requireNonDemo', () => {
    expect(registryDataRouter.stack.filter((l) => !l.route).map((l) => l.handle)).toContain(requireAuth);
    for (const r of routes.filter((x) => x.methods.includes('POST'))) {
      expect(r.handlers).toContain(requireNonDemo);
    }
  });
});

describe('admin registry-data router shape', () => {
  test('drift canary + admin gating', () => {
    const routes = shape(adminRegistryDataRouter);
    expect(routes.map((r) => `${r.methods.join(',')} ${r.path}`).sort()).toEqual([
      'GET /', 'POST /keys/:id/decide', 'POST /values/:id/decide',
    ]);
    // requireAuth + requireRole('admin') ride as router-level use() layers.
    const useLayers = adminRegistryDataRouter.stack.filter((l) => !l.route).map((l) => l.handle);
    expect(useLayers).toContain(requireAuth);
    expect(useLayers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('unauthenticated / non-admin rejection paths', () => {
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/registry-data', registryDataRouter);
    app.use('/api/admin/registry-data', adminRegistryDataRouter);
    server = http.createServer(app);
    server.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  test.each([
    ['GET', '/api/registry-data/keys'],
    ['POST', '/api/registry-data/keys'],
    ['GET', '/api/registry-data/wine/aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['POST', '/api/registry-data/wine/aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['GET', '/api/admin/registry-data'],
    ['POST', '/api/admin/registry-data/keys/aaaaaaaaaaaaaaaaaaaaaaaa/decide'],
  ])('%s %s → 401 without a token', async (method, path) => {
    const res = await fetch(base + path, { method });
    expect(res.status).toBe(401);
  });

  test('a plain user token cannot reach the admin queue', async () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 'a'.repeat(24), roles: ['user'] }, process.env.JWT_SECRET);
    const res = await fetch(`${base}/api/admin/registry-data`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});
