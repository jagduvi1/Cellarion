/**
 * Auth-matrix tests for the REAL /api/discussions router.
 *
 * WHY THIS TEST EXISTS:
 * Discussions are publicly readable (GET with optionalAuth) but writes
 * (POST/PUT/PATCH/DELETE) require authentication, and moderation actions
 * additionally require the moderator/admin role.
 *
 * Unlike a stub that mirrors the middleware table (which silently drifts —
 * an earlier version of this file was missing three real routes), this suite
 * introspects the actual router exported by discussions.js and verifies, by
 * function identity, which auth middleware guards each route. It then fires
 * real HTTP requests through the router for the rejection paths (401/403),
 * which the auth middleware short-circuits before any handler or DB access.
 */

process.env.JWT_SECRET = 'test-secret';

// External-service modules are mocked so requiring the real router has no
// side effects (Meilisearch/Mailgun clients, audit writes). Handlers are
// never reached in this suite, so the mocks just need to exist.
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/notifications', () => ({
  createNotification: jest.fn(),
  createNotifications: jest.fn(),
}));
jest.mock('../services/search', () => ({}));
jest.mock('../services/mailgun', () => ({
  sendDiscussionReplyEmail: jest.fn(),
  EMAIL_VERIFICATION_ENABLED: false,
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { requireAuth, optionalAuth, requireModeratorOrAdmin } = require('../middleware/auth');
const discussionsRouter = require('./discussions');

// ---------------------------------------------------------------------------
// Router introspection: [{ path, methods, handlers }] from the real router.
// ---------------------------------------------------------------------------
const routes = discussionsRouter.stack
  .filter((layer) => layer.route)
  .map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods).map((m) => m.toUpperCase()),
    handlers: layer.route.stack.map((s) => s.handle),
  }));

const writeRoutes = routes.filter((r) => r.methods.some((m) => m !== 'GET'));
const getRoutes = routes.filter((r) => r.methods.includes('GET'));
const modRoutes = routes.filter((r) => r.handlers.includes(requireModeratorOrAdmin));

describe('discussions router shape', () => {
  test('router defines the expected number of routes (drift canary)', () => {
    // 21 routes as of this writing. If you add/remove a route this fails on
    // purpose: update the count AND make sure the new route carries the right
    // auth middleware (the suites below check that automatically).
    expect(routes.length).toBe(21);
  });

  test('every route starts with an auth middleware (requireAuth or optionalAuth)', () => {
    for (const r of routes) {
      expect([requireAuth, optionalAuth]).toContain(r.handlers[0]);
    }
  });
});

describe('write routes require authentication (real router)', () => {
  test('every non-GET route includes requireAuth', () => {
    expect(writeRoutes.length).toBeGreaterThan(0);
    for (const r of writeRoutes) {
      expect(r.handlers).toContain(requireAuth);
    }
  });
});

describe('public reads stay public (real router)', () => {
  test('list, detail and replies GETs use optionalAuth, not requireAuth', () => {
    for (const p of ['/', '/:idOrSlug', '/:idOrSlug/replies']) {
      const r = getRoutes.find((x) => x.path === p);
      expect(r).toBeDefined();
      expect(r.handlers).toContain(optionalAuth);
      expect(r.handlers).not.toContain(requireAuth);
    }
  });
});

describe('moderation routes require moderator/admin (real router)', () => {
  test('all /moderation/* routes carry requireAuth + requireModeratorOrAdmin', () => {
    const moderationPrefixed = routes.filter((r) => r.path.startsWith('/moderation'));
    expect(moderationPrefixed.length).toBeGreaterThanOrEqual(4);
    for (const r of moderationPrefixed) {
      expect(r.handlers).toContain(requireAuth);
      expect(r.handlers).toContain(requireModeratorOrAdmin);
    }
  });

  test('privileged thread actions (delete/pin/lock/move/original) are mod-gated', () => {
    const privileged = [
      ['DELETE', '/:idOrSlug'],
      ['PATCH', '/:idOrSlug/pin'],
      ['PATCH', '/:idOrSlug/lock'],
      ['PATCH', '/:idOrSlug/move'],
      ['GET', '/:discussionId/replies/:replyId/original'],
    ];
    for (const [method, path] of privileged) {
      const r = routes.find((x) => x.path === path && x.methods.includes(method));
      expect(r).toBeDefined();
      expect(r.handlers).toContain(requireModeratorOrAdmin);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioral rejection tests through the REAL router. requireAuth /
// requireModeratorOrAdmin short-circuit with 401/403 before any handler code
// or model call runs, so no DB is needed.
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discussions', discussionsRouter);
  return app;
}

function makeReq(app, method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ port, path: url, method, headers }, (res) => {
        res.resume();
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

const tokenFor = (payload) => jwt.sign(payload, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
const userTok = () => tokenFor({ id: 'u-user', roles: ['user'] });

// Turn an express route path into a concrete URL (':param' → a dummy id).
const concreteUrl = (path) => `/api/discussions${path.replace(/:[A-Za-z]+/g, 'x')}`.replace(/\/$/, '') || '/api/discussions';

describe('behavioral: unauthenticated writes are rejected with 401', () => {
  for (const r of writeRoutes) {
    for (const method of r.methods.filter((m) => m !== 'GET')) {
      test(`${method} ${r.path} → 401 without a token`, async () => {
        const { status } = await makeReq(buildApp(), method, concreteUrl(r.path));
        expect(status).toBe(401);
      });
    }
  }
});

describe('behavioral: regular users are rejected from moderation routes with 403', () => {
  for (const r of modRoutes) {
    for (const method of r.methods) {
      test(`${method} ${r.path} → 403 with a plain user token`, async () => {
        const { status } = await makeReq(buildApp(), method, concreteUrl(r.path), {
          authorization: `Bearer ${userTok()}`,
        });
        expect(status).toBe(403);
      });
    }
  }
});
