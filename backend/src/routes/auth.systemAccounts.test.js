/**
 * The auth routes never issue or honour a verification or reset link for a
 * system account (the "[deleted]" sentinel, any double-underscore name).
 *
 * WHY THIS TEST EXISTS: the sentinel's address is unroutable, so a link sent
 * to it is never delivered — but it is still written to the outgoing-mail log
 * (the mail provider's, a self-hoster's relay). Whoever reads that log could
 * set a password on the sentinel, or verify it and be signed in, and so act as
 * the account every erased member's forum content and reviews point at.
 */
process.env.JWT_SECRET = 'test-secret';

const mockByEmail = new Map();
const mockByVerifyHash = new Map();
const mockByResetHash = new Map();
jest.mock('../models/User', () => {
  function User(doc) { Object.assign(this, doc); }
  User.findOne = jest.fn(async (q) => {
    if (q && q.email) return mockByEmail.get(q.email) || null;
    if (q && q.emailVerificationTokenHash) return mockByVerifyHash.get(q.emailVerificationTokenHash) || null;
    if (q && q.passwordResetTokenHash) return mockByResetHash.get(q.passwordResetTokenHash) || null;
    return null;
  });
  User.BCRYPT_COST = 12;
  return User;
});
jest.mock('../services/authTokens', () => ({
  issueTokens: jest.fn(async () => 'access-token'),
  clearRefreshCookie: jest.fn(),
  clientHint: () => 'test',
  resolveRefreshSession: jest.fn(),
  removeSession: jest.fn(),
  revokeAllSessions: jest.fn(),
  sessionForCookie: jest.fn(),
  hashRefreshToken: jest.fn(),
  COOKIE_SECURE: false,
}));
jest.mock('../services/mailgun', () => ({
  EMAIL_VERIFICATION_ENABLED: true,
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendAccountLockoutAlert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/pendingShares', () => ({ resolvePendingShares: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/mcpOAuth', () => ({ revokeOAuthConnectionsForUser: jest.fn().mockResolvedValue(0) }));
jest.mock('../services/search', () => ({
  initialize: jest.fn(), getIsAvailable: () => false, search: async () => ({ ids: [] }),
  searchBottles: async () => ({ ids: [] }), searchDiscussions: async () => ({ ids: [] }),
  indexWine: jest.fn(), removeWine: jest.fn(), indexBottle: jest.fn(), removeBottle: jest.fn(),
  removeBottles: jest.fn(), bulkIndexBottles: jest.fn(), indexDiscussion: jest.fn(),
  removeDiscussion: jest.fn(), fullSync: jest.fn(), fullSyncBottles: jest.fn(), fullSyncDiscussions: jest.fn(),
}));
jest.mock('../utils/clientIp', () => {
  let n = 0;
  return { rateLimitKey: () => `test-key-${n++}`, getClientIp: () => '127.0.0.1' };
});

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/mailgun');
const { issueTokens } = require('../services/authTokens');
const { SENTINEL_USERNAME, SENTINEL_EMAIL } = require('../utils/deletedUser');
const authRouter = require('./auth');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  mockByEmail.clear(); mockByVerifyHash.clear(); mockByResetHash.clear();
});

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

// A user row with the token methods the routes call; every call is recorded.
function account(username, email) {
  return {
    _id: `id-${username}`,
    username,
    email,
    emailVerified: false,
    password: 'unchanged',
    save: jest.fn(async function save() { return this; }),
    setPasswordResetToken: jest.fn(() => 'reset-token'),
    setEmailVerificationToken: jest.fn(() => 'verify-token'),
    validatePasswordResetToken: jest.fn(() => true),
    validateEmailVerificationToken: jest.fn(() => true),
  };
}

const post = (path, body) => fetch(`${baseUrl}/api/auth${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('forgot-password: the sentinel answers like an unknown address and gets no reset link', async () => {
  const sentinel = account(SENTINEL_USERNAME, SENTINEL_EMAIL);
  mockByEmail.set(SENTINEL_EMAIL, sentinel);
  const res = await post('/forgot-password', { email: SENTINEL_EMAIL });
  expect(res.status).toBe(200);
  expect(sentinel.setPasswordResetToken).not.toHaveBeenCalled();
  expect(sentinel.save).not.toHaveBeenCalled();
  expect(sendPasswordResetEmail).not.toHaveBeenCalled();
});

test('forgot-password: an ordinary member still gets the link', async () => {
  const member = account('alice', 'alice@example.com');
  mockByEmail.set('alice@example.com', member);
  const res = await post('/forgot-password', { email: 'alice@example.com' });
  expect(res.status).toBe(200);
  expect(member.setPasswordResetToken).toHaveBeenCalled();
  expect(sendPasswordResetEmail).toHaveBeenCalledWith('alice@example.com', 'alice', 'reset-token');
});

test('resend-verification: the sentinel gets no verification link', async () => {
  const sentinel = account(SENTINEL_USERNAME, SENTINEL_EMAIL);
  mockByEmail.set(SENTINEL_EMAIL, sentinel);
  const res = await post('/resend-verification', { email: SENTINEL_EMAIL });
  expect(res.status).toBe(200);
  expect(sentinel.setEmailVerificationToken).not.toHaveBeenCalled();
  expect(sendVerificationEmail).not.toHaveBeenCalled();
});

test('reset-password: a token found on a system account is refused and the password stays', async () => {
  const sentinel = account(SENTINEL_USERNAME, SENTINEL_EMAIL);
  mockByResetHash.set(hash('old-reset'), sentinel);
  const res = await post('/reset-password', { token: 'old-reset', password: 'N3w-Password!long' });
  expect(res.status).toBe(400);
  expect(sentinel.password).toBe('unchanged');
  expect(sentinel.save).not.toHaveBeenCalled();
});

test('verify-email: a token found on a system account is refused and nobody is signed in', async () => {
  const system = account('__system', 'system@cellarion.invalid');
  mockByVerifyHash.set(hash('old-verify'), system);
  const res = await post('/verify-email', { token: 'old-verify' });
  expect(res.status).toBe(400);
  expect(system.emailVerified).toBe(false);
  expect(system.save).not.toHaveBeenCalled();
  expect(issueTokens).not.toHaveBeenCalled();
});
