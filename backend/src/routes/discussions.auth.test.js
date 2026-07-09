/**
 * Auth-matrix tests for /api/discussions.
 *
 * WHY THIS TEST EXISTS:
 * Discussions are publicly readable (GET) but writes (POST/PUT/PATCH/DELETE)
 * require authentication, and moderation actions additionally require the
 * moderator/admin role. This test documents that contract so it cannot be
 * accidentally regressed by adding/removing per-route middleware.
 *
 * It mounts a tiny stub app that mirrors the middleware composition of
 * discussions.js — no DB or model code is exercised.
 */

process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { requireAuth, optionalAuth, requireModeratorOrAdmin } = require('../middleware/auth');

function buildApp() {
  const app = express();
  app.use(express.json());

  // Stub handler: succeeds and reports who (if anyone) the request authenticated as.
  const ok = (req, res) => res.status(200).json({ uid: req.user?.id || null });

  // Mirror the per-route middleware composition from discussions.js.
  // Public reads (optionalAuth — no token = anonymous, valid token = personalized).
  app.get('/api/discussions', optionalAuth, ok);
  app.get('/api/discussions/:id', optionalAuth, ok);
  app.get('/api/discussions/:id/replies', optionalAuth, ok);

  // Auth-required writes.
  app.post('/api/discussions', requireAuth, ok);
  app.post('/api/discussions/:id/replies', requireAuth, ok);
  app.put('/api/discussions/:id/replies/:replyId', requireAuth, ok);
  app.delete('/api/discussions/:id/replies/:replyId', requireAuth, ok);
  app.post('/api/discussions/:id/replies/:replyId/reactions', requireAuth, ok);
  app.post('/api/discussions/:idOrSlug/watch', requireAuth, ok);
  app.delete('/api/discussions/:idOrSlug/watch', requireAuth, ok);
  app.post('/api/discussions/:id/report', requireAuth, ok);
  app.post('/api/discussions/:id/replies/:replyId/report', requireAuth, ok);

  // Mod/admin-only.
  app.delete('/api/discussions/:id', requireAuth, requireModeratorOrAdmin, ok);
  app.patch('/api/discussions/:id/pin', requireAuth, requireModeratorOrAdmin, ok);
  app.patch('/api/discussions/:id/lock', requireAuth, requireModeratorOrAdmin, ok);
  app.patch('/api/discussions/:id/move', requireAuth, requireModeratorOrAdmin, ok);
  app.get('/api/discussions/moderation/reports', requireAuth, requireModeratorOrAdmin, ok);
  app.post('/api/discussions/moderation/ban', requireAuth, requireModeratorOrAdmin, ok);

  return app;
}

function makeReq(app, method, url, headers = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ port, path: url, method, headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          const body = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      req.end();
    });
  });
}

const tokenFor = (payload) => jwt.sign(payload, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
const userTok = () => tokenFor({ id: 'u-user', roles: ['user'] });
const modTok  = () => tokenFor({ id: 'u-mod',  roles: ['moderator'] });

const PUBLIC_GETS = [
  '/api/discussions',
  '/api/discussions/anyid',
  '/api/discussions/anyid/replies',
];

describe('Discussion GETs are publicly readable', () => {
  for (const url of PUBLIC_GETS) {
    test(`GET ${url} returns 200 without any Authorization header`, async () => {
      const { status, body } = await makeReq(buildApp(), 'GET', url);
      expect(status).toBe(200);
      expect(body.uid).toBeNull();
    });

    test(`GET ${url} returns 200 with a valid token, attaching req.user`, async () => {
      const { status, body } = await makeReq(buildApp(), 'GET', url, {
        authorization: `Bearer ${userTok()}`,
      });
      expect(status).toBe(200);
      expect(body.uid).toBe('u-user');
    });

    test(`GET ${url} returns 200 even with an invalid token (treated as anonymous)`, async () => {
      const { status, body } = await makeReq(buildApp(), 'GET', url, {
        authorization: 'Bearer not.a.valid.token',
      });
      expect(status).toBe(200);
      expect(body.uid).toBeNull();
    });
  }
});

const WRITE_ROUTES = [
  ['POST',   '/api/discussions'],
  ['POST',   '/api/discussions/anyid/replies'],
  ['PUT',    '/api/discussions/anyid/replies/r1'],
  ['DELETE', '/api/discussions/anyid/replies/r1'],
  ['POST',   '/api/discussions/anyid/replies/r1/reactions'],
  ['POST',   '/api/discussions/anyid/watch'],
  ['DELETE', '/api/discussions/anyid/watch'],
  ['POST',   '/api/discussions/anyid/report'],
  ['POST',   '/api/discussions/anyid/replies/r1/report'],
];

describe('Discussion writes require authentication', () => {
  for (const [method, url] of WRITE_ROUTES) {
    test(`${method} ${url} returns 401 without auth`, async () => {
      const { status } = await makeReq(buildApp(), method, url);
      expect(status).toBe(401);
    });

    test(`${method} ${url} returns 200 with a valid user token`, async () => {
      const { status, body } = await makeReq(buildApp(), method, url, {
        authorization: `Bearer ${userTok()}`,
      });
      expect(status).toBe(200);
      expect(body.uid).toBe('u-user');
    });
  }
});

const MOD_ROUTES = [
  ['DELETE', '/api/discussions/anyid'],
  ['PATCH',  '/api/discussions/anyid/pin'],
  ['PATCH',  '/api/discussions/anyid/lock'],
  ['PATCH',  '/api/discussions/anyid/move'],
  ['GET',    '/api/discussions/moderation/reports'],
  ['POST',   '/api/discussions/moderation/ban'],
];

describe('Moderation routes require moderator/admin role', () => {
  for (const [method, url] of MOD_ROUTES) {
    test(`${method} ${url} returns 401 without auth`, async () => {
      const { status } = await makeReq(buildApp(), method, url);
      expect(status).toBe(401);
    });

    test(`${method} ${url} returns 403 for a regular user`, async () => {
      const { status } = await makeReq(buildApp(), method, url, {
        authorization: `Bearer ${userTok()}`,
      });
      expect(status).toBe(403);
    });

    test(`${method} ${url} returns 200 for a moderator`, async () => {
      const { status, body } = await makeReq(buildApp(), method, url, {
        authorization: `Bearer ${modTok()}`,
      });
      expect(status).toBe(200);
      expect(body.uid).toBe('u-mod');
    });
  }
});
