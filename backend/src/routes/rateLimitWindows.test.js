/**
 * The burst windows an admin saves in SuperAdmin → Settings (PATCH
 * /api/admin/settings/rate-limits) reach the limiters that use them, without
 * a restart:
 *
 *   chatBurst.windowMs        → POST /api/chat
 *   imageUploadBurst.windowMs → POST /api/images/upload
 *   demo.createWindowMs       → POST /api/auth/demo-login
 *
 * The window in force shows in the RateLimit-Reset header of a limiter's
 * first counted request (seconds until the window ends). Each request below
 * stops in the route handler right after the limiter (missing message, no
 * file, demo at capacity), so nothing here talks to a database or an AI.
 */
process.env.JWT_SECRET = 'test-secret';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/demoAccount', () => ({ createDemoAccountWithinCeiling: jest.fn().mockResolvedValue(null) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const rateLimitsConfig = require('../config/rateLimits');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', require('./chat'));
  app.use('/api/images', require('./images'));
  app.use('/api/auth', require('./auth'));
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

let userSeq = 0;
const bearer = () => `Bearer ${jwt.sign({ id: `64b0000000000000000000${String(++userSeq).padStart(2, '0')}`, roles: ['user'] }, 'test-secret')}`;

const withWindow = (group, field, ms) => {
  const config = JSON.parse(JSON.stringify(rateLimitsConfig.defaults));
  config[group][field] = ms;
  rateLimitsConfig.set(config);
};

const LIMITERS = [
  {
    setting: 'chatBurst.windowMs',
    group: 'chatBurst', field: 'windowMs',
    send: () => fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearer() }, body: '{}',
    }),
    status: 400, // message is required
  },
  {
    setting: 'imageUploadBurst.windowMs',
    group: 'imageUploadBurst', field: 'windowMs',
    send: () => fetch(`${baseUrl}/api/images/upload`, { method: 'POST', headers: { Authorization: bearer() } }),
    status: 400, // no image file
  },
  {
    setting: 'demo.createWindowMs',
    group: 'demo', field: 'createWindowMs',
    send: () => fetch(`${baseUrl}/api/auth/demo-login`, { method: 'POST' }),
    status: 429, // the global demo ceiling (mocked as full), not the per-IP limiter
  },
];

describe.each(LIMITERS)('$setting', ({ group, field, send, status }) => {
  test('the saved window is the one in force, and a later save applies too', async () => {
    withWindow(group, field, 7 * 60 * 1000);
    const first = await send();
    expect(first.status).toBe(status);
    expect(Number(first.headers.get('ratelimit-reset'))).toBeGreaterThan(7 * 60 - 5);
    expect(Number(first.headers.get('ratelimit-reset'))).toBeLessThanOrEqual(7 * 60);

    withWindow(group, field, 9 * 60 * 1000);
    const second = await send();
    expect(second.status).toBe(status);
    expect(Number(second.headers.get('ratelimit-reset'))).toBeGreaterThan(9 * 60 - 5);
    expect(Number(second.headers.get('ratelimit-reset'))).toBeLessThanOrEqual(9 * 60);
  });
});
