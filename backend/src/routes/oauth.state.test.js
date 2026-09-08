/**
 * Wiring tests for the Google OAuth round trip's browser binding.
 *
 * WHY THIS TEST EXISTS:
 * oauthStateStore.test.js pins the store's contract; this pins that the strategy
 * actually USES it. The defect being fixed here was invisible at the unit level
 * — every piece worked, and passport-oauth2 quietly fell back to its NullStore
 * because no `store` option was passed — so the assertions that matter are made
 * against the real authorization redirect and the real callback: a `state`
 * parameter is present and mirrored in a cookie on the way out, and a callback
 * that does not present the matching cookie is refused BEFORE the authorization
 * code is exchanged. Neither leg touches the network.
 */

// The strategy registers itself at require time off these, so they are set
// before the router is loaded — and restored afterwards. Jest reuses a worker
// process across suites, so a leaked FRONTEND_URL is not this file's business
// only: it decides hosted-instance behaviour elsewhere and turns unrelated
// suites' responses into 403s.
const ENV_UNDER_TEST = {
  JWT_SECRET: 'test-secret',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  FRONTEND_URL: 'https://cellar.example',
};
const ENV_BEFORE = Object.fromEntries(
  Object.keys(ENV_UNDER_TEST).map((key) => [key, process.env[key]])
);
Object.assign(process.env, ENV_UNDER_TEST);

afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

jest.mock('../models/User', () => ({ findOne: () => Promise.resolve(null) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/pendingShares', () => ({ resolvePendingShares: jest.fn() }));

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const passport = require('passport');

const oauthRouter = require('./oauth');
const { DEFAULT_COOKIE_NAME } = require('../services/oauthStateStore');

let server;
let base;

beforeAll((done) => {
  const app = express();
  app.use(cookieParser());
  app.use('/api/auth', oauthRouter);
  server = http.createServer(app).listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections?.();
  server.close(() => done());
});

const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers });

/** The state cookie's value as the browser would store it, or undefined. */
function stateCookie(res) {
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const line = setCookie.filter(Boolean).find((c) => c.startsWith(`${DEFAULT_COOKIE_NAME}=`));
  return line;
}

describe('GET /api/auth/google', () => {
  it('sends state and a PKCE challenge to Google, and mirrors the state in a cookie', async () => {
    const res = await get('/api/auth/google');
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location'));
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');

    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');

    const cookie = stateCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`${DEFAULT_COOKIE_NAME}=${state}.`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/auth');
  });

  it('issues a fresh state per sign-in attempt', async () => {
    const [a, b] = await Promise.all([get('/api/auth/google'), get('/api/auth/google')]);
    const stateOf = (res) => new URL(res.headers.get('location')).searchParams.get('state');
    expect(stateOf(a)).not.toBe(stateOf(b));
  });
});

describe('GET /api/auth/google/callback', () => {
  it('refuses a code presented without the cookie that started the flow', async () => {
    // The attack: a code minted in the attacker's browser, delivered to the
    // victim's by an ordinary top-level navigation. The victim's browser holds
    // no state cookie for it.
    const res = await get('/api/auth/google/callback?code=attacker-code&state=attacker-state');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://cellar.example/login/callback?error=invalid_state');
  });

  it('refuses a code whose state does not match the cookie', async () => {
    const started = await get('/api/auth/google');
    const cookie = stateCookie(started).split(';')[0];

    const res = await get('/api/auth/google/callback?code=attacker-code&state=not-the-issued-state', { cookie });

    expect(res.headers.get('location')).toBe('https://cellar.example/login/callback?error=invalid_state');
  });

  it('sends the cookie\'s PKCE verifier to the token endpoint, and it matches the challenge', async () => {
    // The positive half of the round trip: state verified, verifier recovered
    // from the cookie, and handed to the exchange. Asserting the verifier
    // HASHES to the challenge issued on the way out is what proves the pair
    // belongs to this flow rather than merely being present.
    const started = await get('/api/auth/google');
    const authorize = new URL(started.headers.get('location'));
    const challenge = authorize.searchParams.get('code_challenge');
    const state = authorize.searchParams.get('state');
    const cookie = stateCookie(started).split(';')[0];

    const strategy = passport._strategy('google');
    const realExchange = strategy._oauth2.getOAuthAccessToken;
    let sentVerifier;
    // Stop at the token endpoint: what it would answer is Google's business,
    // and the assertion is about what we sent it. Failing the exchange keeps
    // the test off the network without mocking the whole strategy.
    strategy._oauth2.getOAuthAccessToken = (code, params, cb) => {
      sentVerifier = params.code_verifier;
      cb(new Error('token endpoint not called in tests'));
    };

    try {
      await get(`/api/auth/google/callback?code=any-code&state=${encodeURIComponent(state)}`, { cookie });
    } finally {
      strategy._oauth2.getOAuthAccessToken = realExchange;
    }

    expect(sentVerifier).toBeTruthy();
    expect(crypto.createHash('sha256').update(sentVerifier).digest('base64url')).toBe(challenge);
  });

  it('clears the state cookie when the user cancels at the consent screen', async () => {
    // passport-oauth2 answers ?error=... BEFORE consulting the state store, so
    // the store cannot clean up after this one — the route has to. Without it
    // an abandoned flow leaves its state in the browser for the cookie's whole
    // lifetime.
    const started = await get('/api/auth/google');
    const cookie = stateCookie(started).split(';')[0];

    const res = await get('/api/auth/google/callback?error=access_denied', { cookie });

    expect(res.headers.get('location')).toBe('https://cellar.example/login/callback?error=access_denied');
    const cleared = stateCookie(res);
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(new RegExp(`^${DEFAULT_COOKIE_NAME}=;`));
  });

  it('clears the state cookie on a provider error that is not a cancellation', async () => {
    const started = await get('/api/auth/google');
    const cookie = stateCookie(started).split(';')[0];

    const res = await get('/api/auth/google/callback?error=temporarily_unavailable', { cookie });

    const cleared = stateCookie(res);
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(new RegExp(`^${DEFAULT_COOKIE_NAME}=;`));
  });

  it('clears the state cookie on a refused callback, so the flow cannot be retried with it', async () => {
    const started = await get('/api/auth/google');
    const cookie = stateCookie(started).split(';')[0];

    const res = await get('/api/auth/google/callback?code=c&state=wrong', { cookie });

    const cleared = stateCookie(res);
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(new RegExp(`^${DEFAULT_COOKIE_NAME}=;`));
  });
});
