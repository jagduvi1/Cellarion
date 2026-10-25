/**
 * POST /api/auth/register — the two things the app relies on at sign-up.
 *
 * WHY THIS TEST EXISTS:
 * 1. A new account is marked localeDefaultsPending, so its first sign-in saves
 *    the browser's language and currency (POST /api/users/me/locale-defaults).
 *    Without the mark a Swedish visitor is switched to English at sign-up.
 * 2. A taken username or email answers with one code for both, so the app can
 *    say what to try next in the user's language without revealing which one
 *    exists (no account enumeration).
 */
process.env.JWT_SECRET = 'test-secret';

const mockCreated = [];
jest.mock('../models/User', () => {
  function User(doc) { Object.assign(this, doc); this._id = 'u-new'; mockCreated.push(this); }
  User.prototype.save = jest.fn(async function save() { return this; });
  User.prototype.toJSON = function toJSON() { return { id: this._id, username: this.username }; };
  User.findOne = jest.fn();
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
}));
jest.mock('../services/mailgun', () => ({
  EMAIL_VERIFICATION_ENABLED: false,
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendAccountLockoutAlert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/pendingShares', () => ({ resolvePendingShares: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/mcpOAuth', () => ({ revokeOAuthConnectionsForUser: jest.fn().mockResolvedValue(0) }));
// auth.js → services/demoAccount → … → services/search requires the ESM-only
// meilisearch; stub it as the other auth suites do.
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

const express = require('express');
const http = require('http');
const User = require('../models/User');
const { issueTokens } = require('../services/authTokens');
const authRouter = require('./auth');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => { jest.clearAllMocks(); mockCreated.length = 0; });

const register = (body) => fetch(`${baseUrl}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'anna', email: 'anna@example.com', password: 'Correct-horse-9',
    consentPrivacyPolicy: true, consentDataProcessing: true, ...body,
  }),
});

test('with email verification off there is no signup binding cookie (the account is signed in at once)', async () => {
  User.findOne.mockResolvedValue(null);

  const res = await register();

  expect(res.status).toBe(201);
  expect(res.headers.get('set-cookie') || '').not.toMatch(/signupBinding/);
});

test('a new account is marked for first-sign-in language + currency defaults', async () => {
  User.findOne.mockResolvedValue(null);

  const res = await register();

  expect(res.status).toBe(201);
  expect(mockCreated).toHaveLength(1);
  expect(mockCreated[0].localeDefaultsPending).toBe(true);
});

test('the duplicate check looks up the trimmed name and address', async () => {
  User.findOne.mockResolvedValue({ _id: 'someone' });

  await register({ username: 'anna ', email: ' Anna@Example.com ' });

  expect(User.findOne).toHaveBeenCalledWith({ $or: [{ email: 'anna@example.com' }, { username: 'anna' }] });
});

test('a registration that loses a race on the unique index gets the same answer, not a 500', async () => {
  User.findOne.mockResolvedValue(null);
  // With verification off the account is first written when the session is
  // issued (issueTokens saves it); that write is where the race surfaces.
  issueTokens.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

  const res = await register();

  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'REGISTRATION_REJECTED' });
});

test('a taken username or email answers one code for both', async () => {
  User.findOne.mockResolvedValue({ _id: 'someone' });

  const res = await register();

  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'REGISTRATION_REJECTED' });
  expect(mockCreated).toHaveLength(0);
});
