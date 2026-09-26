/**
 * POST /api/auth/refresh rate limits (scaling audit 2026-09-25): 30 per
 * 15 min for one refresh TOKEN — not one address, which many people can share
 * (a carrier's NAT, an office) — plus a per-address ceiling of 300 so made-up
 * cookies can't flood the session lookup. The real router and limiters over a
 * real HTTP server; a fresh module registry per file gives them fresh counters.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/User', () => {
  const model = { findOne: jest.fn(async () => null), findById: jest.fn(async () => null) };
  model.BCRYPT_COST = 12;
  return model;
});
jest.mock('../services/mailgun', () => ({
  EMAIL_VERIFICATION_ENABLED: false,
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendAccountLockoutAlert: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/mcpOAuth', () => ({ revokeOAuthConnectionsForUser: jest.fn() }));
jest.mock('../models/PendingShare', () => ({ find: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
// auth.js → demoAccount → cellarImport → search → ESM-only meilisearch
// (unparseable by jest): stub it, as auth.refresh.test.js does.
jest.mock('../services/search', () => ({ initialize: jest.fn(), getIsAvailable: () => false }));

// The address every request appears to come from — set per test.
let mockIp = '198.51.100.1';
jest.mock('../utils/clientIp', () => ({
  rateLimitKey: () => mockIp,
  getClientIp: () => mockIp,
}));

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const authRouter = require('./auth');

let server;
let port;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  server = http.createServer(app);
  server.listen(0, () => { port = server.address().port; done(); });
});
afterAll((done) => {
  server.closeAllConnections?.();
  server.close(() => done());
});

const refresh = (cookie) => new Promise((resolve, reject) => {
  const req = http.request({ port, path: '/api/auth/refresh', method: 'POST', headers: cookie ? { cookie } : {} }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end();
});
const madeUpCookie = () => `refreshToken=${crypto.randomBytes(64).toString('hex')}`;

test('the limit follows the refresh token: a 31st try with the same token is 429, another token from the same address is not', async () => {
  mockIp = '198.51.100.1';
  const cookieA = madeUpCookie();
  for (let i = 0; i < 30; i++) expect(await refresh(cookieA)).toBe(401); // unknown token, but counted
  expect(await refresh(cookieA)).toBe(429);
  // Someone else behind the same address is unaffected.
  expect(await refresh(madeUpCookie())).toBe(401);
});

test('without a cookie the limit falls back to the address', async () => {
  mockIp = '198.51.100.2';
  for (let i = 0; i < 30; i++) expect(await refresh(null)).toBe(401);
  expect(await refresh(null)).toBe(429);
});

test('one address is capped at 300 refreshes per window, however many cookies it makes up', async () => {
  mockIp = '198.51.100.3';
  const statuses = [];
  for (let i = 0; i < 300; i++) statuses.push(await refresh(madeUpCookie()));
  expect(statuses.every((s) => s === 401)).toBe(true);
  expect(await refresh(madeUpCookie())).toBe(429);
  // A different address still gets through.
  mockIp = '198.51.100.4';
  expect(await refresh(madeUpCookie())).toBe(401);
});
