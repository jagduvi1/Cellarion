/**
 * Behavioral tests for the two highest-value untested slices of routes/auth.js:
 *
 *   1. Refresh-token ROTATION flow (POST /refresh, POST /logout)
 *   2. Password-RESET flow (POST /forgot-password, POST /reset-password)
 *
 * The REAL auth router is mounted (with the real requireAuth middleware, real
 * express-rate-limit limiters, real cookie-parser) and driven over an actual
 * HTTP server — same pattern as stripe.checkout.test.js / racks.nfc.test.js.
 * The User model, mailgun, audit and the register-path models are mocked; the
 * fake user docs replicate the REAL User schema methods byte-for-byte
 * (sha256 token hashing, expiry windows) so the route↔model contract is
 * exercised, not a strawman. No DB, no network, no email leaves the process.
 *
 * Notable behaviors PINNED here (found by reading the code, not guessed):
 *
 *  - Rotation: every successful /refresh replaces refreshTokenHash, so the
 *    previous token is dead immediately. There is NO reuse-detection /
 *    token-family revocation: presenting an already-rotated token returns a
 *    generic 401 and does NOT revoke the live session (see the reuse test —
 *    flagged there as a deliberate pin of current behavior).
 *  - The absolute 30-day session deadline (refreshTokenExpiresAt) is
 *    PRESERVED across rotation and BACKFILLED (fresh 30 days) for legacy
 *    sessions where it is null.
 *  - Remember-me is sticky: a session started with rememberMe=false keeps
 *    getting a browser-session cookie (no Max-Age/Expires) on rotation.
 *  - clearRefreshCookie clears BOTH Path=/api/auth and legacy Path=/ variants.
 *  - forgot-password returns a byte-identical 200 body for known and unknown
 *    emails (no body-level enumeration oracle) and stores only sha256(token).
 *  - reset-password consumes the token, invalidates ALL refresh sessions and
 *    clears the brute-force lockout counter (but not lockoutEmailSentAt).
 */

process.env.JWT_SECRET = 'test-secret';

// ── Mocks (hoisted above all requires) ──────────────────────────────────────

// User is fully mocked; the module also needs BCRYPT_COST because auth.js
// asserts at load time that its DUMMY_HASH matches the model's bcrypt cost.
jest.mock('../models/User', () => {
  const model = { findOne: jest.fn(), findById: jest.fn() };
  model.BCRYPT_COST = 12;
  return model;
});

// No email must leave the process. EMAIL_VERIFICATION_ENABLED: true makes the
// forgot-password route actually attempt the send (the branch under test).
jest.mock('../services/mailgun', () => ({
  EMAIL_VERIFICATION_ENABLED: true,
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendAccountLockoutAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));

// Only touched by the register / verify-email paths (resolvePendingShares) —
// mocked so requiring the router doesn't pull real mongoose schemas.
jest.mock('../models/PendingShare', () => ({ find: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));

// auth.js now transitively requires the search service (auth.js →
// services/demoAccount → services/cellarImport → services/search), and
// services/search does `require('meilisearch')` at module load. meilisearch@0.58
// is ESM-only (its only `.` export is an ESM dist/index.js); Node 20.19+ loads it
// at runtime via require(esm), but jest's CJS module runtime can't parse it — so
// merely requiring auth.js would fail this whole suite at load. A factory mock
// short-circuits the chain (jest never loads the real search.js, hence never
// meilisearch), matching how the route suites (bottles.restore, cellarImport,
// import.confirm, …) already stub search. This suite never exercises search.
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

// Give every request a UNIQUE rate-limit key so the real express-rate-limit
// limiters are mounted (their wiring is exercised) but never trip mid-suite.
jest.mock('../utils/clientIp', () => {
  let n = 0;
  return {
    rateLimitKey: () => `test-key-${n++}`,
    getClientIp: (req) => (req && req.ip) || '127.0.0.1',
  };
});

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const User = require('../models/User');
const { sendPasswordResetEmail } = require('../services/mailgun');
const authRouter = require('./auth');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// Frozen clock — makes the 1h reset-token expiry and the 30-day absolute
// session deadline exactly assertable.
const NOW = 1752105600000; // 2026-07-10T00:00:00Z
const DAY = 24 * 60 * 60 * 1000;

// ── In-memory "users collection" mirroring the real schema methods ──────────

let users;

function makeUserDoc(overrides = {}) {
  const doc = {
    _id: 'u1',
    username: 'johan',
    email: 'johan@example.com',
    password: '$2a$12$existinghashexistinghashexistinghashexistingha12345',
    roles: ['user'],
    plan: 'free',
    planExpiresAt: null,
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
    refreshTokenPersistent: null,
    passwordResetTokenHash: null,
    passwordResetExpiresAt: null,
    failedLoginAttempts: { count: 0, firstFailedAt: null, lockedUntil: null, lockoutEmailSentAt: null },
    save: jest.fn().mockResolvedValue(undefined),
    markModified: jest.fn(),
    toJSON() { return { id: this._id, username: this.username, email: this.email }; },
    // ── Replicas of the REAL User schema methods (models/User.js) ──
    setRefreshToken(token) {
      this.refreshTokenHash = sha256(token);
    },
    setPasswordResetToken() {
      const token = crypto.randomBytes(32).toString('hex');
      this.passwordResetTokenHash = sha256(token);
      this.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      return token;
    },
    validatePasswordResetToken(candidateToken) {
      if (!this.passwordResetTokenHash || !this.passwordResetExpiresAt) return false;
      if (Date.now() > this.passwordResetExpiresAt.getTime()) return false;
      const hash = sha256(candidateToken);
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.passwordResetTokenHash));
    },
    ...overrides,
  };
  users.push(doc);
  return doc;
}

// Plant a refresh session on a user exactly the way issueTokens() would have:
// stored hash + absolute deadline + persistence flag. Returns the raw cookie value.
function plantRefreshToken(user, { persistent = null, expiresAt = new Date(NOW + 10 * DAY) } = {}) {
  const raw = crypto.randomBytes(64).toString('hex');
  user.refreshTokenHash = sha256(raw);
  user.refreshTokenExpiresAt = expiresAt;
  user.refreshTokenPersistent = persistent;
  return raw;
}

const matches = (u, q) => {
  if (q.$or) return q.$or.some((c) => matches(u, c));
  return Object.entries(q).every(([k, v]) => u[k] === v);
};

// ── One HTTP server for the suite ────────────────────────────────────────────

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

let dateNowSpy;

beforeEach(() => {
  jest.clearAllMocks();
  users = [];
  dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);

  User.findOne.mockImplementation(async (query) => users.find((u) => matches(u, query)) || null);
  User.findById.mockImplementation(async (id) => users.find((u) => String(u._id) === String(id)) || null);
});

afterEach(() => dateNowSpy.mockRestore());

// ── HTTP helpers ─────────────────────────────────────────────────────────────

const request = ({ method = 'POST', path, body, cookie, bearer }) => new Promise((resolve, reject) => {
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const headers = {};
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const req = http.request({ port, path, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      resolve({
        status: res.statusCode,
        body: raw ? JSON.parse(raw) : null,
        setCookies: res.headers['set-cookie'] || [],
      });
    });
  });
  req.on('error', reject);
  req.end(payload);
});

const tokenFor = (id) =>
  jwt.sign({ id, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });

const parseSetCookie = (str) => {
  const parts = str.split(';').map((s) => s.trim());
  const eq = parts[0].indexOf('=');
  const attrs = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i === -1) attrs[p.toLowerCase()] = true;
    else attrs[p.slice(0, i).toLowerCase()] = p.slice(i + 1);
  }
  return { name: parts[0].slice(0, eq), value: decodeURIComponent(parts[0].slice(eq + 1)), attrs };
};

const refreshCookies = (res) =>
  res.setCookies.map(parseSetCookie).filter((c) => c.name === 'refreshToken');

// clearRefreshCookie() must emit TWO deletions: the scoped Path=/api/auth
// cookie and the legacy Path=/ cookie (pre-L-23 sessions).
const expectClearedCookies = (res) => {
  const cleared = refreshCookies(res).filter((c) => c.value === '');
  expect(cleared).toHaveLength(2);
  const paths = cleared.map((c) => c.attrs.path).sort();
  expect(paths).toEqual(['/', '/api/auth']);
  for (const c of cleared) {
    expect(c.attrs.httponly).toBe(true);
    expect(c.attrs.samesite).toBe('Lax');
    // Deletion = epoch expiry, and crucially NO Max-Age (a Max-Age would make
    // Express re-derive a future expiry and leave an empty cookie behind).
    expect(c.attrs.expires).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
    expect(c.attrs['max-age']).toBeUndefined();
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Refresh-token rotation flow
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/auth/refresh — rotation', () => {
  test('valid cookie → new access token, refresh token ROTATED, cookie attrs pinned', async () => {
    const user = makeUserDoc();
    const oldRaw = plantRefreshToken(user); // persistent=null (legacy) → persistent cookie
    const oldHash = user.refreshTokenHash;

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${oldRaw}` });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['token']); // no user object leaks on refresh

    // The access token is a real HS256 JWT carrying id/roles/plan
    const decoded = jwt.verify(res.body.token, 'test-secret', { algorithms: ['HS256'] });
    expect(decoded).toMatchObject({ id: 'u1', roles: ['user'], plan: 'free', planExpiresAt: null });

    // Rotation: exactly one new refresh cookie, value differs from the old token,
    // and the stored hash now matches the NEW cookie (old hash gone).
    const cookies = refreshCookies(res);
    expect(cookies).toHaveLength(1);
    const rotated = cookies[0];
    expect(rotated.value).not.toBe(oldRaw);
    expect(rotated.value).toMatch(/^[0-9a-f]{128}$/); // 64 random bytes, hex
    expect(user.refreshTokenHash).toBe(sha256(rotated.value));
    expect(user.refreshTokenHash).not.toBe(oldHash);
    expect(user.save).toHaveBeenCalled();

    // Cookie attributes as the code sets them (NODE_ENV=test → no Secure flag)
    expect(rotated.attrs.httponly).toBe(true);
    expect(rotated.attrs.samesite).toBe('Lax');
    expect(rotated.attrs.path).toBe('/api/auth');
    expect(rotated.attrs['max-age']).toBe('604800'); // 7-day persistent cookie
    expect(rotated.attrs.secure).toBeUndefined();
  });

  test('rotation PRESERVES the absolute session deadline (does not extend it)', async () => {
    const user = makeUserDoc();
    const deadline = new Date(NOW + 10 * DAY);
    const raw = plantRefreshToken(user, { expiresAt: deadline });

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(200);
    expect(user.refreshTokenExpiresAt.getTime()).toBe(deadline.getTime());
  });

  test('legacy session with NO deadline gets backfilled with a fresh 30-day cap', async () => {
    const user = makeUserDoc();
    const raw = plantRefreshToken(user, { expiresAt: null });

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(200);
    expect(user.refreshTokenExpiresAt.getTime()).toBe(NOW + 30 * DAY);
  });

  test('missing cookie → 401, no cookie touched', async () => {
    const res = await request({ path: '/api/auth/refresh' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'No refresh token' });
    expect(res.setCookies).toEqual([]);
  });

  test('unknown token → 401 and the cookie is cleared on both paths', async () => {
    makeUserDoc(); // a user exists, but this token matches nobody
    const res = await request({
      path: '/api/auth/refresh',
      cookie: `refreshToken=${'ab'.repeat(64)}`,
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired refresh token' });
    expectClearedCookies(res);
  });

  test('rotated (already-used) token is rejected — and reuse does NOT revoke the live session', async () => {
    const user = makeUserDoc();
    const tokenA = plantRefreshToken(user);

    // 1) legitimate rotation: A → B
    const first = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenA}` });
    expect(first.status).toBe(200);
    const tokenB = refreshCookies(first)[0].value;

    // 2) replaying the rotated token A fails with the generic 401
    const replay = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenA}` });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Invalid or expired refresh token' });

    // 3) PINNED CURRENT BEHAVIOR — no reuse-detection / token-family
    // revocation: the reuse attempt above did NOT invalidate the live token B.
    // A stricter design would treat reuse of a rotated token as theft evidence
    // and revoke the whole session; the code does not do that today.
    const after = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenB}` });
    expect(after.status).toBe(200);
  });

  test('absolute deadline passed → 401 "Session expired", server-side hash purged, cookie cleared', async () => {
    const user = makeUserDoc();
    const raw = plantRefreshToken(user, { expiresAt: new Date(NOW - 1000) });

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Session expired, please log in again' });
    expect(user.refreshTokenHash).toBeNull();
    expect(user.refreshTokenExpiresAt).toBeNull();
    expect(user.save).toHaveBeenCalled();
    expectClearedCookies(res);
  });

  test('remember-me=false session is NOT silently upgraded: rotation reissues a session cookie', async () => {
    const user = makeUserDoc();
    const raw = plantRefreshToken(user, { persistent: false });

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(200);
    const [rotated] = refreshCookies(res);
    // Session cookie: no Max-Age and no Expires — dies with the browser
    expect(rotated.attrs['max-age']).toBeUndefined();
    expect(rotated.attrs.expires).toBeUndefined();
    expect(rotated.attrs.path).toBe('/api/auth');
    expect(rotated.attrs.httponly).toBe(true);
    // and the persistence choice survives the rotation for the NEXT one too
    expect(user.refreshTokenPersistent).toBe(false);
  });
});

describe('POST /api/auth/logout', () => {
  test('revokes the server-side refresh token and clears the cookie on both paths', async () => {
    const user = makeUserDoc();
    plantRefreshToken(user);
    expect(user.refreshTokenHash).not.toBeNull();

    const res = await request({ path: '/api/auth/logout', bearer: tokenFor('u1') });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out' });
    expect(user.refreshTokenHash).toBeNull();
    expect(user.save).toHaveBeenCalled();
    expectClearedCookies(res);
  });

  test('requires authentication (real requireAuth middleware) → 401 without a bearer token', async () => {
    const res = await request({ path: '/api/auth/logout' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'No token provided' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Password-reset flow
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/auth/forgot-password', () => {
  test('known email → reset token stored as sha256 hash with 1h expiry, email send attempted with the RAW token', async () => {
    const user = makeUserDoc();

    const res = await request({ path: '/api/auth/forgot-password', body: { email: 'johan@example.com' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'If that email exists, a password reset link has been sent.' });

    // The email carries the RAW token; the DB stores ONLY its sha256 hash
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [toEmail, username, rawToken] = sendPasswordResetEmail.mock.calls[0];
    expect(toEmail).toBe('johan@example.com');
    expect(username).toBe('johan');
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
    expect(user.passwordResetTokenHash).toBe(sha256(rawToken));
    expect(user.passwordResetTokenHash).not.toBe(rawToken);
    expect(user.passwordResetExpiresAt.getTime()).toBe(NOW + 60 * 60 * 1000); // 1 hour
    expect(user.save).toHaveBeenCalled();
  });

  test('email lookup is case-insensitive (route lowercases before querying)', async () => {
    const user = makeUserDoc();

    const res = await request({ path: '/api/auth/forgot-password', body: { email: 'JoHaN@ExAmPlE.cOm' } });

    expect(res.status).toBe(200);
    expect(user.passwordResetTokenHash).not.toBeNull();
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  test('unknown email → byte-identical 200 response, NO token created, NO email sent (no enumeration oracle)', async () => {
    const user = makeUserDoc();

    const known = await request({ path: '/api/auth/forgot-password', body: { email: 'johan@example.com' } });
    const knownEmailCalls = sendPasswordResetEmail.mock.calls.length;

    const unknown = await request({ path: '/api/auth/forgot-password', body: { email: 'nobody@example.com' } });

    // Same status, same body for known and unknown emails — the response is
    // not an account-existence oracle. (A timing difference remains — the
    // known path does a save + hash — but the route relies on the dedicated
    // 5-per-15-min forgotLimiter to blunt that; body parity is what we pin.)
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(sendPasswordResetEmail.mock.calls.length).toBe(knownEmailCalls); // no extra email
    expect(user.save).toHaveBeenCalledTimes(1); // only the known-email request saved
  });

  test('non-string email (NoSQL-operator shaped) → 400, never reaches the query', async () => {
    const res = await request({ path: '/api/auth/forgot-password', body: { email: { $ne: null } } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Email is required' });
    expect(User.findOne).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/reset-password', () => {
  const NEW_PASSWORD = 'NewSecret123!xyz';

  // Seed a user that already requested a reset; returns { user, rawToken }
  const seedWithResetToken = (overrides = {}) => {
    const user = makeUserDoc(overrides);
    const rawToken = user.setPasswordResetToken();
    user.save.mockClear();
    return { user, rawToken };
  };

  test('valid token → password updated, token consumed, ALL refresh sessions invalidated, lockout cleared', async () => {
    const { user, rawToken } = seedWithResetToken({
      // user is currently locked out from a brute-force run…
      failedLoginAttempts: {
        count: 10,
        firstFailedAt: new Date(NOW - 5 * 60 * 1000),
        lockedUntil: new Date(NOW + 60 * 60 * 1000),
        lockoutEmailSentAt: new Date(NOW - 5 * 60 * 1000),
      },
    });
    plantRefreshToken(user); // …and has a live refresh session

    const res = await request({
      path: '/api/auth/reset-password',
      body: { token: rawToken, password: NEW_PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password reset successfully. You can now log in with your new password.' });

    // Password handed to the model (the real model's pre-save hook bcrypts it;
    // that hook is unit-tested with the model, not here) and persisted.
    expect(user.password).toBe(NEW_PASSWORD);
    expect(user.save).toHaveBeenCalledTimes(1);

    // Token consumed
    expect(user.passwordResetTokenHash).toBeNull();
    expect(user.passwordResetExpiresAt).toBeNull();

    // Every existing session is killed server-side + cookie cleared client-side
    expect(user.refreshTokenHash).toBeNull();
    expectClearedCookies(res);

    // Brute-force lockout cleared (explicit recovery signal)…
    expect(user.failedLoginAttempts.count).toBe(0);
    expect(user.failedLoginAttempts.lockedUntil).toBeNull();
    expect(user.failedLoginAttempts.firstFailedAt).toBeNull();
    // …but the email-dedupe timestamp is intentionally KEPT (no lockout-then-spam)
    expect(user.failedLoginAttempts.lockoutEmailSentAt).not.toBeNull();
  });

  test('a consumed token cannot be reused', async () => {
    const { rawToken } = seedWithResetToken();

    const first = await request({
      path: '/api/auth/reset-password',
      body: { token: rawToken, password: NEW_PASSWORD },
    });
    expect(first.status).toBe(200);

    const replay = await request({
      path: '/api/auth/reset-password',
      body: { token: rawToken, password: 'AnotherSecret123!' },
    });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ error: 'Invalid or expired reset token' });
  });

  test('expired token (hash still stored, past 1h window) → 400, password untouched', async () => {
    const { user, rawToken } = seedWithResetToken();
    user.passwordResetExpiresAt = new Date(NOW - 1000);
    const oldPassword = user.password;

    const res = await request({
      path: '/api/auth/reset-password',
      body: { token: rawToken, password: NEW_PASSWORD },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid or expired reset token' });
    expect(user.password).toBe(oldPassword);
    expect(user.save).not.toHaveBeenCalled();
  });

  test('unknown token → 400 with the same generic error', async () => {
    seedWithResetToken();

    const res = await request({
      path: '/api/auth/reset-password',
      body: { token: 'ff'.repeat(32), password: NEW_PASSWORD },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid or expired reset token' });
  });

  test('missing token or password → 400', async () => {
    const noToken = await request({ path: '/api/auth/reset-password', body: { password: NEW_PASSWORD } });
    const noPassword = await request({ path: '/api/auth/reset-password', body: { token: 'ff'.repeat(32) } });

    for (const res of [noToken, noPassword]) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Token and new password are required' });
    }
  });

  test('model ValidationError (weak new password) → 400 with the model message', async () => {
    const { user, rawToken } = seedWithResetToken();
    const validationError = Object.assign(new Error('validation failed'), {
      name: 'ValidationError',
      errors: { password: { message: 'Password must be at least 12 characters and include an uppercase letter, lowercase letter, number, and special character' } },
    });
    user.save.mockRejectedValueOnce(validationError);

    const res = await request({
      path: '/api/auth/reset-password',
      body: { token: rawToken, password: 'weak' },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Password must be at least 12 characters and include an uppercase letter, lowercase letter, number, and special character' });
  });

  test('cross-flow: a refresh token that was valid BEFORE the reset is dead AFTER it', async () => {
    const { user, rawToken } = seedWithResetToken();
    const refreshRaw = plantRefreshToken(user);

    // Sanity: the session works before the reset
    const before = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${refreshRaw}` });
    expect(before.status).toBe(200);
    const rotatedRaw = refreshCookies(before)[0].value;

    const reset = await request({
      path: '/api/auth/reset-password',
      body: { token: rawToken, password: NEW_PASSWORD },
    });
    expect(reset.status).toBe(200);

    // The (freshly rotated!) refresh token no longer resolves any session
    const after = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${rotatedRaw}` });
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ error: 'Invalid or expired refresh token' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email — must NOT issue a session (security audit M-1)
// ---------------------------------------------------------------------------
describe('POST /api/auth/verify-email', () => {
  const withVerifyToken = (raw) => makeUserDoc({
    emailVerified: false,
    emailVerificationTokenHash: sha256(raw),
    emailVerificationExpiresAt: new Date(NOW + 24 * 60 * 60 * 1000),
    validateEmailVerificationToken(candidate) {
      if (!this.emailVerificationTokenHash || !this.emailVerificationExpiresAt) return false;
      if (Date.now() > this.emailVerificationExpiresAt.getTime()) return false;
      return sha256(candidate) === this.emailVerificationTokenHash;
    },
  });

  test('verifies the email and issues NO session (no token, no refresh cookie)', async () => {
    const user = withVerifyToken('verify-raw-token');
    const res = await request({ method: 'POST', path: '/api/auth/verify-email', body: { token: 'verify-raw-token' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true, message: expect.any(String) });
    // The login-CSRF/session-fixation fix: no access token, no refresh cookie.
    expect(res.body.token).toBeUndefined();
    expect(res.setCookies).toEqual([]);
    expect(user.emailVerified).toBe(true);
    expect(user.emailVerificationTokenHash).toBeNull();
    expect(user.save).toHaveBeenCalled();
  });

  test('rejects an unknown/expired token without issuing a session', async () => {
    makeUserDoc(); // a user exists, but no verification token matches
    const res = await request({ method: 'POST', path: '/api/auth/verify-email', body: { token: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.setCookies).toEqual([]);
  });

  test('400 with no token', async () => {
    const res = await request({ method: 'POST', path: '/api/auth/verify-email', body: {} });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/whoami — minimal stable identity for scoped integrations
// ---------------------------------------------------------------------------
describe('GET /api/auth/whoami', () => {
  test('returns ONLY the account id for an authenticated session', async () => {
    const res = await request({ method: 'GET', path: '/api/auth/whoami', bearer: tokenFor('user-abc') });
    expect(res.status).toBe(200);
    // No email/plan/roles — id and nothing else (HA reads data.id).
    expect(res.body).toEqual({ id: 'user-abc' });
  });

  test('401 without a credential', async () => {
    const res = await request({ method: 'GET', path: '/api/auth/whoami' });
    expect(res.status).toBe(401);
  });
});
