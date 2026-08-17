/**
 * Auth-matrix test for /api/wine-proposals (#985 Slice A), in the
 * personalData.auth.test.js style: introspect the real router, then fire
 * real requests for the rejection paths.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// wineProposalOps top-requires wineVisibility; keep the require side-effect free.
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));

const express = require('express');
const http = require('http');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const wineProposalsRouter = require('./wineProposals');

const routes = wineProposalsRouter.stack
  .filter((layer) => layer.route)
  .map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods).map((m) => m.toUpperCase()),
    handlers: layer.route.stack.map((s) => s.handle),
  }));

const useLayers = wineProposalsRouter.stack.filter((l) => !l.route).map((l) => l.handle);

describe('wine-proposals router shape', () => {
  test('router defines the expected routes (drift canary)', () => {
    const map = routes.map((r) => `${r.methods.join(',')} ${r.path}`).sort();
    expect(map).toEqual(['GET /mine', 'POST /']);
  });

  test('requireAuth guards the whole router; the write carries requireNonDemo', () => {
    expect(useLayers).toContain(requireAuth);
    const post = routes.find((r) => r.methods.includes('POST'));
    expect(post.handlers).toContain(requireNonDemo);
  });
});

describe('unauthenticated requests are rejected before any handler runs', () => {
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/wine-proposals', wineProposalsRouter);
    server = http.createServer(app);
    server.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  test.each([
    ['POST', '/api/wine-proposals'],
    ['GET', '/api/wine-proposals/mine?wine=aaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('%s %s → 401 without a token', async (method, path) => {
    const res = await fetch(base + path, { method });
    expect(res.status).toBe(401);
  });
});
