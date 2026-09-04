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
 *  - Sessions are PER DEVICE (user.sessions[], 2026-09-04): /refresh rotates
 *    only the entry its cookie belongs to, so the previous token is dead
 *    immediately while every other device keeps working. /logout removes
 *    only its own entry. A pre-sessions single-token row (refreshTokenHash)
 *    is adopted into sessions[] on its first /refresh — the rollout signs
 *    nobody out.
 *  - Reuse detection: an already-rotated token presented again within 60 s
 *    is a lost tab race (plain 401, nothing revoked); later than that it is
 *    theft evidence and EVERY session on the account is revoked + audited.
 *  - The absolute 30-day session deadline (session.expiresAt) is PRESERVED
 *    across rotation and BACKFILLED (fresh 30 days) for legacy sessions
 *    where it is null.
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
jest.mock('../services/mcpOAuth', () => ({ revokeOAuthConnectionsForUser: jest.fn().mockResolvedValue(2) }));

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
    sessions: [],
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

// Plant a DEVICE session on a user exactly the way issueTokens() would have:
// stored hash + absolute deadline + persistence flag. Returns the raw cookie value.
function plantRefreshToken(user, { persistent = true, expiresAt = new Date(NOW + 10 * DAY), client = 'Windows / Chrome' } = {}) {
  const raw = crypto.randomBytes(64).toString('hex');
  user.sessions.push({
    hash: sha256(raw), prevHash: null, rotatedAt: null, expiresAt, persistent,
    createdAt: new Date(NOW), lastUsedAt: new Date(NOW), client,
  });
  return raw;
}

// A PRE-SESSIONS row: the single refreshTokenHash an account used to carry
// before per-device sessions. Adopted into sessions[] on its first /refresh.
function plantLegacyRefreshToken(user, { persistent = null, expiresAt = new Date(NOW + 10 * DAY) } = {}) {
  const raw = crypto.randomBytes(64).toString('hex');
  user.refreshTokenHash = sha256(raw);
  user.refreshTokenExpiresAt = expiresAt;
  user.refreshTokenPersistent = persistent;
  return raw;
}

const sessionOf = (user, raw) => user.sessions.find((s) => s.hash === sha256(raw));

// Mongo-style matcher for the in-memory store: flat equality plus dotted
// paths into arrays ('sessions.hash' → some element's hash), as the real
// session lookups query.
const matches = (u, q) => {
  if (q.$or) return q.$or.some((c) => matches(u, c));
  return Object.entries(q).every(([k, v]) => {
    const [head, ...rest] = k.split('.');
    if (rest.length && Array.isArray(u[head])) return u[head].some((el) => el[rest.join('.')] === v);
    return u[k] === v;
  });
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
    const oldRaw = plantRefreshToken(user); // persistent (remember-me) session
    const oldHash = sha256(oldRaw);

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
    expect(user.sessions).toHaveLength(1); // rotated IN PLACE, no second entry
    const session = sessionOf(user, rotated.value);
    expect(session).toBeDefined();
    expect(session.prevHash).toBe(oldHash); // kept for reuse detection
    expect(session.rotatedAt.getTime()).toBe(NOW);
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
    expect(user.sessions[0].expiresAt.getTime()).toBe(deadline.getTime());
  });

  test('legacy session with NO deadline gets backfilled with a fresh 30-day cap', async () => {
    const user = makeUserDoc();
    const raw = plantRefreshToken(user, { expiresAt: null });

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(200);
    expect(user.sessions[0].expiresAt.getTime()).toBe(NOW + 30 * DAY);
  });

  test('two devices: each refresh rotates ONLY its own session, the other keeps working', async () => {
    const user = makeUserDoc();
    const phone = plantRefreshToken(user, { client: 'Android / Chrome' });
    const laptop = plantRefreshToken(user, { client: 'Windows / Firefox' });

    // The phone refreshes — this used to sign the laptop out.
    const phoneRes = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${phone}` });
    expect(phoneRes.status).toBe(200);
    expect(user.sessions).toHaveLength(2);
    expect(sessionOf(user, laptop)).toBeDefined(); // laptop untouched

    // The laptop refreshes with its ORIGINAL cookie — still valid.
    const laptopRes = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${laptop}` });
    expect(laptopRes.status).toBe(200);
    expect(user.sessions).toHaveLength(2);
    expect(user.sessions.map((s) => s.client).sort()).toEqual(['Android / Chrome', 'Windows / Firefox']);

    // And the phone's rotated cookie keeps working too.
    const phone2 = refreshCookies(phoneRes)[0].value;
    expect((await request({ path: '/api/auth/refresh', cookie: `refreshToken=${phone2}` })).status).toBe(200);
  });

  test('a pre-sessions single-token row is adopted on its first refresh — nobody is signed out by the rollout', async () => {
    const user = makeUserDoc();
    const deadline = new Date(NOW + 12 * DAY);
    const raw = plantLegacyRefreshToken(user, { persistent: false, expiresAt: deadline });

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(200);
    // Legacy fields cleared, one device session in their place with the same
    // deadline and remember-me choice, labelled from this request's UA.
    expect(user.refreshTokenHash).toBeNull();
    expect(user.refreshTokenExpiresAt).toBeNull();
    expect(user.refreshTokenPersistent).toBeNull();
    expect(user.sessions).toHaveLength(1);
    const [session] = user.sessions;
    expect(session.hash).toBe(sha256(refreshCookies(res)[0].value));
    expect(session.prevHash).toBe(sha256(raw));
    expect(session.expiresAt.getTime()).toBe(deadline.getTime());
    expect(session.persistent).toBe(false);
    expect(refreshCookies(res)[0].attrs['max-age']).toBeUndefined(); // still a session cookie
    expect(session.client).toBe('Unknown device'); // node's http client sends no UA
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

  test('a rotated token replayed within 60 s is a lost tab race: generic 401, nothing revoked', async () => {
    const user = makeUserDoc();
    const tokenA = plantRefreshToken(user);
    const other = plantRefreshToken(user, { client: 'iOS / Safari' }); // another device, must survive

    // 1) legitimate rotation: A → B
    const first = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenA}` });
    expect(first.status).toBe(200);
    const tokenB = refreshCookies(first)[0].value;

    // 2) replaying A ten seconds later fails with the generic 401…
    dateNowSpy.mockReturnValue(NOW + 10 * 1000);
    const replay = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenA}` });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Invalid or expired refresh token' });
    expectClearedCookies(replay);

    // 3) …and revokes nothing: the live token B and the other device both work.
    const { logAudit } = require('../services/audit');
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'auth.session.reuse_detected', expect.anything(), expect.anything());
    expect((await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenB}` })).status).toBe(200);
    expect((await request({ path: '/api/auth/refresh', cookie: `refreshToken=${other}` })).status).toBe(200);
  });

  test('a rotated token replayed AFTER the grace window is theft evidence: every session revoked, audited', async () => {
    const user = makeUserDoc();
    const tokenA = plantRefreshToken(user, { client: 'Windows / Chrome' });
    const other = plantRefreshToken(user, { client: 'iOS / Safari' });

    const first = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenA}` });
    const tokenB = refreshCookies(first)[0].value;

    // Five minutes later someone presents the OLD cookie A.
    dateNowSpy.mockReturnValue(NOW + 5 * 60 * 1000);
    const replay = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenA}` });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Invalid or expired refresh token' }); // same generic body
    expectClearedCookies(replay);

    // Account signed out everywhere, with a traceable audit row.
    expect(user.sessions).toEqual([]);
    expect(user.save).toHaveBeenCalled();
    const { logAudit } = require('../services/audit');
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'auth.session.reuse_detected',
      { type: 'user', id: 'u1' }, { client: 'Windows / Chrome' });
    expect((await request({ path: '/api/auth/refresh', cookie: `refreshToken=${tokenB}` })).status).toBe(401);
    expect((await request({ path: '/api/auth/refresh', cookie: `refreshToken=${other}` })).status).toBe(401);
  });

  test('absolute deadline passed → 401 "Session expired", that device purged, others kept, cookie cleared', async () => {
    const user = makeUserDoc();
    const raw = plantRefreshToken(user, { expiresAt: new Date(NOW - 1000) });
    const other = plantRefreshToken(user, { client: 'iOS / Safari' });

    const res = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Session expired, please log in again' });
    expect(user.sessions).toHaveLength(1);
    expect(sessionOf(user, other)).toBeDefined();
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
    expect(user.sessions[0].persistent).toBe(false);
  });
});

describe('POST /api/auth/logout', () => {
  test('revokes ONLY this device\'s session (by its cookie) and clears the cookie on both paths', async () => {
    const user = makeUserDoc();
    const laptop = plantRefreshToken(user, { client: 'Windows / Chrome' });
    const phone = plantRefreshToken(user, { client: 'Android / Chrome' });

    const res = await request({ path: '/api/auth/logout', bearer: tokenFor('u1'), cookie: `refreshToken=${laptop}` });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out' });
    expect(user.sessions).toHaveLength(1);
    expect(sessionOf(user, phone)).toBeDefined();
    expect(sessionOf(user, laptop)).toBeUndefined();
    expect(user.save).toHaveBeenCalled();
    expectClearedCookies(res);
    // the phone is still signed in
    expect((await request({ path: '/api/auth/refresh', cookie: `refreshToken=${phone}` })).status).toBe(200);
  });

  test('logout right after a rotation still finds its session (by the just-rotated hash)', async () => {
    const user = makeUserDoc();
    const raw = plantRefreshToken(user);
    const rotated = await request({ path: '/api/auth/refresh', cookie: `refreshToken=${raw}` });
    expect(rotated.status).toBe(200);

    // A stale tab logging out with the pre-rotation cookie
    const res = await request({ path: '/api/auth/logout', bearer: tokenFor('u1'), cookie: `refreshToken=${raw}` });
    expect(res.status).toBe(200);
    expect(user.sessions).toHaveLength(0);
  });

  test('a pre-sessions cookie is cleared from the legacy field the same way', async () => {
    const user = makeUserDoc();
    const raw = plantLegacyRefreshToken(user);

    const res = await request({ path: '/api/auth/logout', bearer: tokenFor('u1'), cookie: `refreshToken=${raw}` });

    expect(res.status).toBe(200);
    expect(user.refreshTokenHash).toBeNull();
    expect(user.refreshTokenExpiresAt).toBeNull();
  });

  test('without a cookie nothing can be identified server-side: sessions untouched, cookie still cleared', async () => {
    const user = makeUserDoc();
    plantRefreshToken(user);

    const res = await request({ path: '/api/auth/logout', bearer: tokenFor('u1') });

    expect(res.status).toBe(200);
    expect(user.sessions).toHaveLength(1);
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

    // Every device session is killed server-side + cookie cleared client-side
    expect(user.sessions).toEqual([]);
    expect(user.refreshTokenHash).toBeNull();
    expectClearedCookies(res);

    // Connected AI assistants (OAuth grants) are revoked too — a reset is the
    // account-recovery signal, so a phished third-party grant must not survive
    // it (security report 2026-08-27). Personal PATs are spared by the helper.
    const { revokeOAuthConnectionsForUser } = require('../services/mcpOAuth');
    expect(revokeOAuthConnectionsForUser).toHaveBeenCalledWith(user._id);

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

  // Same L-2 guard as /verify-email — this endpoint hashes the token first too.
  test.each([
    ['an operator object', { $ne: null }],
    ['an array',           ['a']],
    ['a number',           12345],
  ])('400, never 500, when the token is %s', async (_label, token) => {
    seedWithResetToken();
    const res = await request({
      path: '/api/auth/reset-password',
      body: { token, password: NEW_PASSWORD },
    });
    expect(res.status).toBe(400);
  });

  test('a non-string token never reaches the User lookup', async () => {
    seedWithResetToken();
    User.findOne.mockClear();
    const res = await request({
      path: '/api/auth/reset-password',
      body: { token: { $ne: null }, password: NEW_PASSWORD },
    });
    expect(res.status).toBe(400);
    expect(User.findOne).not.toHaveBeenCalled();
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

  // Security audit 2026-07-25 L-2. A JSON object is truthy, so the old
  // truthiness check let it reach crypto's update(), which throws a TypeError
  // the catch turned into a 500 + a full stack trace on an UNAUTHENTICATED
  // endpoint. Nothing was exploitable (it throws before the Mongo query, so no
  // operator ever reached the database) — but the answer must be 400.
  test.each([
    ['an operator object', { $ne: null }],
    ['an array',           ['a']],
    ['a number',           12345],
    ['a boolean',          true],
  ])('400, never 500, when the token is %s', async (_label, token) => {
    const res = await request({ method: 'POST', path: '/api/auth/verify-email', body: { token } });
    expect(res.status).toBe(400);
    expect(res.setCookies).toEqual([]);
  });

  test('a non-string token never reaches the User lookup', async () => {
    User.findOne.mockClear();
    const res = await request({
      method: 'POST', path: '/api/auth/verify-email', body: { token: { $ne: null } },
    });
    expect(res.status).toBe(400);
    expect(User.findOne).not.toHaveBeenCalled();
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
