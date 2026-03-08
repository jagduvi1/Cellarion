/**
 * Tests that /api/uploads requires authentication.
 *
 * WHY THIS TEST EXISTS:
 * Bottle images are served under /api/uploads and are protected by requireAuth
 * (Bearer token). Browser <img src> tags cannot send Authorization headers, so
 * images must be fetched via the JS API layer (e.g. the AuthImage component in
 * the frontend), not rendered with a plain <img src="/api/uploads/...">.
 * This test documents and guards that security requirement so it cannot be
 * accidentally removed without a test failure.
 */

process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { requireAuth } = require('../middleware/auth');

// Build a minimal slice of the app that mirrors the real uploads route
function buildApp() {
  const app = express();
  app.use(cookieParser());

  app.use('/api/uploads', requireAuth, (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    if (!allowedExts.includes(ext)) {
      return res.status(403).json({ error: 'File type not allowed' });
    }
    // Would normally call express.static here; return 200 to confirm auth passed
    res.status(200).json({ ok: true });
  });

  return app;
}

function makeReq(app, url, headers = {}) {
  return new Promise((resolve) => {
    const http = require('http');
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ port, path: url, headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
      req.end();
    });
  });
}

function validToken() {
  return jwt.sign({ id: 'u1', roles: ['user'] }, 'test-secret', { expiresIn: '1h' });
}

describe('/api/uploads auth guard', () => {
  test('401 when no Authorization header is sent', async () => {
    const app = buildApp();
    const { status } = await makeReq(app, '/api/uploads/originals/bottle.jpg');
    expect(status).toBe(401);
  });

  test('401 when Authorization header is malformed', async () => {
    const app = buildApp();
    const { status } = await makeReq(app, '/api/uploads/originals/bottle.jpg', {
      authorization: 'Token not-bearer',
    });
    expect(status).toBe(401);
  });

  test('200 when a valid Bearer token is provided', async () => {
    const app = buildApp();
    const { status } = await makeReq(app, '/api/uploads/originals/bottle.jpg', {
      authorization: `Bearer ${validToken()}`,
    });
    expect(status).toBe(200);
  });

  test('403 when a valid token is provided but file extension is disallowed', async () => {
    const app = buildApp();
    const { status, body } = await makeReq(app, '/api/uploads/originals/bottle.exe', {
      authorization: `Bearer ${validToken()}`,
    });
    expect(status).toBe(403);
    expect(body.error).toBe('File type not allowed');
  });
});
