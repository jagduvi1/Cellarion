/**
 * POST /api/auth/login: the per-account lockout under guesses sent at the same
 * moment.
 *
 * WHY THIS TEST EXISTS:
 * Until 2026-09-27 each login request loaded the account, compared the
 * password, then wrote the failure counter back from the copy it loaded.
 * Guesses sent at the same moment all loaded count 0 and overwrote each other:
 * 40 wrong passwords at once were counted as 4 or less, and the account never
 * locked. Worse, a right guess that finished after the lock took effect still
 * got in, because it checked the lock on its own stale copy.
 *
 * Here every request gets its OWN copy of the account (as a real findOne
 * does), bcrypt is slowed so all 40 load before any fails, and the counter
 * update is applied atomically in call order, as MongoDB applies the pipeline.
 */

process.env.JWT_SECRET = 'test-secret';

const mockDb = { user: null, nowMs: 0 };

jest.mock('../models/User', () => {
  const copy = () => (mockDb.user ? JSON.parse(JSON.stringify(mockDb.user), (k, v) => (
    typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v
  )) : null);
  const lean = (value) => ({ lean: async () => { await null; return value; } });
  const model = {
    // Each request loads its own snapshot, with the document methods the route uses.
    findOne: jest.fn(async () => {
      const doc = copy();
      if (!doc) return null;
      return Object.assign(doc, {
        save: jest.fn(async () => { mockDb.user.failedLoginAttempts = doc.failedLoginAttempts; }),
        markModified: jest.fn(),
        toJSON() { return { id: doc._id, username: doc.username }; },
      });
    }),
    findOneAndUpdate: jest.fn((filter) => {
      if (!mockDb.user || String(filter._id) !== String(mockDb.user._id)) return lean(null);
      const before = copy();
      const { nextFailureState } = jest.requireActual('../utils/loginAttempts');
      const rateLimitsConfig = jest.requireActual('../config/rateLimits');
      mockDb.user.failedLoginAttempts = nextFailureState(
        mockDb.user.failedLoginAttempts, Date.now(), rateLimitsConfig.get().accountLockout,
      ).state;
      return lean(before);
    }),
    updateOne: jest.fn(async (filter, update) => {
      const fla = mockDb.user.failedLoginAttempts;
      if (fla.lockoutEmailSentAt) return { modifiedCount: 0 };
      fla.lockoutEmailSentAt = update.$set['failedLoginAttempts.lockoutEmailSentAt'];
      return { modifiedCount: 1 };
    }),
    findById: jest.fn(() => ({ select: () => lean(copy()) })),
  };
  model.BCRYPT_COST = 12;
  return model;
});

// Slow compares: every request of a burst loads the account before the first
// one finishes. The right password can be made to finish only once the burst
// has locked the account (ordered by the lock itself, not by timers, so a busy
// machine cannot reorder it; capped at 5 s so a regression fails, not hangs).
const mockRightWaitsForLock = { value: false };
jest.mock('bcrypt', () => ({
  getRounds: () => 12,
  compare: jest.fn((password) => new Promise((resolve) => {
    if (password !== 'right-password') { setTimeout(() => resolve(false), 5); return; }
    if (!mockRightWaitsForLock.value) { setTimeout(() => resolve(true), 5); return; }
    const until = Date.now() + 5000;
    const poll = () => {
      if (mockDb.user?.failedLoginAttempts?.lockedUntil || Date.now() > until) resolve(true);
      else setTimeout(poll, 2);
    };
    setTimeout(poll, 5);
  })),
}));

jest.mock('../services/authTokens', () => ({
  issueTokens: jest.fn(async () => 'access-token'),
  clearRefreshCookie: jest.fn(),
  clientHint: () => 'test',
  resolveRefreshSession: jest.fn(),
  removeSession: jest.fn(),
  revokeAllSessions: jest.fn(),
  sessionForCookie: jest.fn(),
  hashRefreshToken: jest.fn(),
}));
jest.mock('../services/mailgun', () => ({
  EMAIL_VERIFICATION_ENABLED: false,
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendAccountLockoutAlert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/mcpOAuth', () => ({ revokeOAuthConnectionsForUser: jest.fn().mockResolvedValue(0) }));
jest.mock('../models/PendingShare', () => ({ find: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
// auth.js → services/demoAccount → … → services/search requires the ESM-only
// meilisearch; stub it as the other auth suites do.
jest.mock('../services/search', () => ({
  initialize: jest.fn(),
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  searchBottles: async () => ({ ids: [] }),
  searchDiscussions: async () => ({ ids: [] }),
  indexWine: jest.fn(),
  removeWine: jest.fn(),
  indexBottle: jest.fn(),
  removeBottle: jest.fn(),
  removeBottles: jest.fn(),
  bulkIndexBottles: jest.fn(),
  indexDiscussion: jest.fn(),
  removeDiscussion: jest.fn(),
  fullSync: jest.fn(),
  fullSyncBottles: jest.fn(),
  fullSyncDiscussions: jest.fn(),
}));
// A different address per request: the per-IP auth limiter never trips, the
// way an attacker with many addresses sees it.
jest.mock('../utils/clientIp', () => {
  let n = 0;
  return { rateLimitKey: () => `test-key-${n++}`, getClientIp: () => '127.0.0.1' };
});

const express = require('express');
const http = require('http');
const { logAudit } = require('../services/audit');
const { sendAccountLockoutAlert } = require('../services/mailgun');
const rateLimitsConfig = require('../config/rateLimits');
const authRouter = require('./auth');

let server;
let port;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = http.createServer(app);
  server.listen(0, () => { port = server.address().port; done(); });
});

afterAll((done) => {
  server.closeAllConnections?.();
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRightWaitsForLock.value = false;
  rateLimitsConfig.set({
    ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)),
    accountLockout: { threshold: 10, windowMs: 15 * 60 * 1000, durationMs: 60 * 60 * 1000, emailDedupMs: 60 * 60 * 1000 },
  });
  mockDb.user = {
    _id: 'u1',
    username: 'anna',
    email: 'anna@example.com',
    password: '$2a$12$stored-hash-is-never-compared-for-real-here',
    emailVerified: true,
    failedLoginAttempts: { count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null },
  };
});

const login = (password) => new Promise((resolve, reject) => {
  const payload = JSON.stringify({ username: 'anna', password });
  const req = http.request({
    host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
  });
  req.on('error', reject);
  req.end(payload);
});

const auditCount = (action) => logAudit.mock.calls.filter((c) => c[1] === action).length;

test('40 wrong passwords at the same moment lock the account, once, with one email', async () => {
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => login(`guess-${i}`)));

  expect(results.every((r) => r.status === 401)).toBe(true);
  expect(mockDb.user.failedLoginAttempts.count).toBe(10);
  expect(new Date(mockDb.user.failedLoginAttempts.lockedUntil).getTime()).toBeGreaterThan(Date.now());
  expect(auditCount('auth.account_locked')).toBe(1);
  expect(sendAccountLockoutAlert).toHaveBeenCalledTimes(1);

  // The right password is refused while the lock holds.
  expect((await login('right-password')).status).toBe(401);
});

test('a right guess finishing after the lock took effect is refused, though it loaded the account unlocked', async () => {
  mockRightWaitsForLock.value = true; // finishes only once the burst has locked the account
  const User = require('../models/User');
  const results = await Promise.all([
    login('right-password'),
    ...Array.from({ length: 12 }, (_, i) => login(`guess-${i}`)),
  ]);

  expect(results[0].status).toBe(401);
  // Refused by the live check (its own copy said unlocked), not by that copy.
  expect(User.findById).toHaveBeenCalled();
  expect(auditCount('auth.login.locked')).toBe(1);
  expect(auditCount('auth.login.success')).toBe(0);
});

test('below the threshold the right password signs in and clears the counter', async () => {
  await Promise.all(Array.from({ length: 3 }, (_, i) => login(`guess-${i}`)));
  expect(mockDb.user.failedLoginAttempts.count).toBe(3);

  const res = await login('right-password');
  expect(res.status).toBe(200);
  expect(res.body.token).toBe('access-token');
  expect(mockDb.user.failedLoginAttempts.count).toBe(0);
});
