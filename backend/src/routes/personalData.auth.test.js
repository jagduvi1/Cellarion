/**
 * Auth-matrix test for the REAL /api/personal-data router (#986), in the
 * discussions.auth.test.js style: introspect the exported router and verify
 * by function identity which middleware guards each route, then fire real
 * requests for the rejection paths.
 *
 * The rules pinned here:
 *  - every route requires authentication (there is no public surface);
 *  - every WRITE additionally carries requireNonDemo (demo accounts are
 *    hard-deleted by the reaper — their entries would orphan);
 *  - the two bottle-context routes gate through requireBottleAccess (param
 *    must be :id — the factory reads req.params.id).
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const personalDataRouter = require('./personalData');

const routes = personalDataRouter.stack
  .filter((layer) => layer.route)
  .map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods).map((m) => m.toUpperCase()),
    handlers: layer.route.stack.map((s) => s.handle),
  }));

// router.use(requireAuth) guards everything before any route layer.
const useLayers = personalDataRouter.stack.filter((l) => !l.route).map((l) => l.handle);

describe('personal-data router shape', () => {
  test('router defines the expected routes (drift canary)', () => {
    const map = routes.map((r) => `${r.methods.join(',')} ${r.path}`).sort();
    expect(map).toEqual([
      'DELETE /entries/:entryId',
      'GET /bottle/:id',
      'GET /keys',
      'POST /bottle/:id',
      'PUT /entries/:entryId',
    ]);
  });

  test('requireAuth guards the whole router', () => {
    expect(useLayers).toContain(requireAuth);
  });

  test('every write route carries requireNonDemo', () => {
    const writes = routes.filter((r) => r.methods.some((m) => m !== 'GET'));
    expect(writes.length).toBe(3);
    for (const r of writes) {
      expect(r.handlers).toContain(requireNonDemo);
    }
  });

  test('bottle-context routes use the :id param requireBottleAccess reads', () => {
    // requireBottleAccess() returns a fresh closure, so identity can't be
    // checked — but its contract (req.params.id) can: the param name must be
    // :id or the middleware 400s every request.
    const bottleRoutes = routes.filter((r) => r.path.startsWith('/bottle/'));
    expect(bottleRoutes.length).toBe(2);
    for (const r of bottleRoutes) {
      expect(r.path).toBe('/bottle/:id');
    }
  });
});

describe('unauthenticated requests are rejected before any handler runs', () => {
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/personal-data', personalDataRouter);
    server = http.createServer(app);
    server.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  const cases = [
    ['GET', '/api/personal-data/keys'],
    ['GET', '/api/personal-data/bottle/aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['POST', '/api/personal-data/bottle/aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['PUT', '/api/personal-data/entries/aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['DELETE', '/api/personal-data/entries/aaaaaaaaaaaaaaaaaaaaaaaa'],
  ];

  test.each(cases)('%s %s → 401 without a token', async (method, path) => {
    const res = await fetch(base + path, { method });
    expect(res.status).toBe(401);
  });
});
