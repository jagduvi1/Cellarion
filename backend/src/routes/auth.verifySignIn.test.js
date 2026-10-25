/**
 * POST /api/auth/verify-email signs a new member in ONLY in the browser that
 * registered the account (services/signupBinding).
 *
 * WHY THIS TEST EXISTS: a session-issuing verify step is a login-CSRF hole —
 * an attacker registers, takes their own verification link and gets a victim's
 * browser to open it, silently signing the victim in to the attacker's account
 * (security audit M-1). The binding cookie set at registration is what makes
 * the convenience safe, so every way of NOT having the right binding must still
 * verify without a session.
 */
process.env.JWT_SECRET = 'test-secret';

const mockCreated = [];
const mockUsers = new Map();
jest.mock('../models/User', () => {
  function User(doc) { Object.assign(this, doc); this._id = 'u-new'; mockCreated.push(this); }
  User.prototype.save = jest.fn(async function save() { return this; });
  User.prototype.setEmailVerificationToken = function setToken() { this.emailVerificationTokenHash = 'h'; return 'tok-new'; };
  User.prototype.toJSON = function toJSON() { return { id: this._id, username: this.username }; };
  User.findOne = jest.fn(async (q) => (q && q.emailVerificationTokenHash ? mockUsers.get(q.emailVerificationTokenHash) || null : null));
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
const User = require('../models/User');
const { issueTokens } = require('../services/authTokens');
const { logAudit } = require('../services/audit');
const { setSignupBinding, hasSignupBinding } = require('../services/signupBinding');
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
beforeEach(() => { jest.clearAllMocks(); mockCreated.length = 0; mockUsers.clear(); });

// The cookie value the registration of `id` sets.
const bindingFor = (id) => { let v; setSignupBinding({ cookie: (_n, val) => { v = val; } }, id); return v; };

// An unverified account whose verification token is `token`.
function unverifiedAccount(id, token, extra = {}) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const user = {
    _id: id, username: id, email: `${id}@example.com`, emailVerified: false,
    emailVerificationTokenHash: hash,
    validateEmailVerificationToken: (t) => t === token,
    save: jest.fn(async function save() { return this; }),
    toJSON() { return { id: this._id, username: this.username }; },
    ...extra,
  };
  mockUsers.set(hash, user);
  return user;
}

const verify = (token, cookie) => fetch(`${baseUrl}/api/auth/verify-email`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify({ token }),
});

test('registration marks the registering browser with an httpOnly, strict, auth-scoped binding cookie', async () => {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'anna', email: 'anna@example.com', password: 'Correct-horse-9', consentPrivacyPolicy: true, consentDataProcessing: true }),
  });
  expect(res.status).toBe(202);
  const set = res.headers.get('set-cookie') || '';
  const value = (/signupBinding=([^;]+)/.exec(set) || [])[1];
  expect(hasSignupBinding({ cookies: { signupBinding: value } }, 'u-new')).toBe(true);
  expect(hasSignupBinding({ cookies: { signupBinding: value } }, 'someone-else')).toBe(false);
  expect(set).toMatch(/HttpOnly/i);
  expect(set).toMatch(/SameSite=Strict/i);
  expect(set).toMatch(/Path=\/api\/auth/i);
  expect(issueTokens).not.toHaveBeenCalled();
});

test('the registering browser is signed in when it opens its own verification link', async () => {
  const user = unverifiedAccount('u1', 'tok-1');

  const res = await verify('tok-1', `signupBinding=${bindingFor('u1')}`);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ verified: true, token: 'access-token', persistent: true, user: { id: 'u1' } });
  expect(user.emailVerified).toBe(true);
  expect(issueTokens).toHaveBeenCalledTimes(1);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'auth.login.success', { type: 'user', id: 'u1' }, { username: 'u1', via: 'email_verification' });
  expect(res.headers.get('set-cookie') || '').toMatch(/signupBinding=;/);
});

test('any other browser only verifies (no session)', async () => {
  const user = unverifiedAccount('u2', 'tok-2');

  const res = await verify('tok-2');

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.verified).toBe(true);
  expect(body.token).toBeUndefined();
  expect(user.emailVerified).toBe(true);
  expect(issueTokens).not.toHaveBeenCalled();
});

test("login-CSRF: a victim's browser opening an attacker's link is not signed in to the attacker's account", async () => {
  unverifiedAccount('attacker', 'tok-attacker');
  // The victim's browser registered its own account earlier and still holds that binding.
  const res = await verify('tok-attacker', `signupBinding=${bindingFor('victim')}`);

  expect(res.status).toBe(200);
  expect((await res.json()).token).toBeUndefined();
  expect(issueTokens).not.toHaveBeenCalled();
  // The victim's own binding is left for the victim's own link.
  expect(res.headers.get('set-cookie')).toBeNull();
});

test('a forged or malformed binding cookie does not sign in', async () => {
  unverifiedAccount('u3', 'tok-3');
  for (const cookie of ['signupBinding=' + 'a'.repeat(64), 'signupBinding=x', 'signupBinding=']) {
    const res = await verify('tok-3', cookie);
    expect((await res.json()).token).toBeUndefined();
    unverifiedAccount('u3', 'tok-3'); // the token was consumed; reissue it for the next try
  }
  expect(issueTokens).not.toHaveBeenCalled();
});

test('a locked account, an account being deleted and a demo account only verify', async () => {
  unverifiedAccount('locked', 'tok-l', { failedLoginAttempts: { count: 10, lockedUntil: new Date(Date.now() + 3600e3) } });
  unverifiedAccount('leaving', 'tok-d', { deletionScheduledFor: new Date(Date.now() + 864e5) });
  unverifiedAccount('demo', 'tok-demo', { isDemo: true });

  for (const [id, tok] of [['locked', 'tok-l'], ['leaving', 'tok-d'], ['demo', 'tok-demo']]) {
    const res = await verify(tok, `signupBinding=${bindingFor(id)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeUndefined();
  }
  expect(issueTokens).not.toHaveBeenCalled();
});

test('a binding older than 7 days is refused by the server, whatever the browser kept', async () => {
  unverifiedAccount('u4', 'tok-4');
  let old;
  setSignupBinding({ cookie: (_n, val) => { old = val; } }, 'u4', Date.now() - 8 * 864e5);

  const res = await verify('tok-4', `signupBinding=${old}`);

  expect((await res.json()).token).toBeUndefined();
  expect(issueTokens).not.toHaveBeenCalled();
});

test('a sign-in that fails after verifying still reports the email as verified', async () => {
  const user = unverifiedAccount('u5', 'tok-5');
  issueTokens.mockRejectedValueOnce(new Error('session save failed'));

  const res = await verify('tok-5', `signupBinding=${bindingFor('u5')}`);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ verified: true });
  expect(body.token).toBeUndefined();
  expect(user.emailVerified).toBe(true);
});

test('signing out clears a signup binding left in the browser', async () => {
  const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { Cookie: `signupBinding=${bindingFor('u6')}` } });
  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie') || '').toMatch(/signupBinding=;/);
});

test('an invalid token is still refused, binding or not', async () => {
  const res = await verify('nope', `signupBinding=${bindingFor('u-new')}`);
  expect(res.status).toBe(400);
  expect(issueTokens).not.toHaveBeenCalled();
  expect(User.findOne).toHaveBeenCalled();
});
