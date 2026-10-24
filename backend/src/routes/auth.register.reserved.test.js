/**
 * POST /api/auth/register refuses the reserved system names.
 *
 * WHY THIS TEST EXISTS:
 * The "[deleted]" sentinel is looked up by its username, and every account
 * erasure re-points the erased member's forum content at it. On an instance
 * where no erasure has run yet the name is free, so a visitor who registers it
 * would inherit every erased member's threads and replies. Registration answers
 * a reserved name with the ordinary username-rule message (nothing new to
 * translate, nothing that says the name is special) and creates no account.
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
beforeEach(() => {
  jest.clearAllMocks();
  mockCreated.length = 0;
  // The name is free, as it is on an instance where no erasure has run yet.
  User.findOne.mockResolvedValue(null);
});

const register = (body) => fetch(`${baseUrl}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'anna', email: 'anna@example.com', password: 'Correct-horse-9',
    consentPrivacyPolicy: true, consentDataProcessing: true, ...body,
  }),
});

const USERNAME_RULE_MESSAGE = 'Username must be 3–30 characters and use only letters, numbers, dots, underscores, or hyphens.';

test.each([
  '__deleted__',
  '__DELETED__',
  ' __deleted__ ',
  '__anything',
])('the reserved name %j is refused with the username-rule message and no account', async (username) => {
  const res = await register({ username });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: USERNAME_RULE_MESSAGE });
  expect(mockCreated).toHaveLength(0);
});

test('a name that only resembles the sentinel still registers', async () => {
  const res = await register({ username: 'deleted' });

  expect(res.status).toBe(201);
  expect(mockCreated).toHaveLength(1);
  expect(mockCreated[0].username).toBe('deleted');
});

test('a single leading underscore is still an ordinary name', async () => {
  const res = await register({ username: '_anna' });

  expect(res.status).toBe(201);
  expect(mockCreated).toHaveLength(1);
});
