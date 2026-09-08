/**
 * Wiring tests for the generic OIDC provider (#1203).
 *
 * WHY THIS TEST EXISTS, AND WHY GOOGLE IS UNSET HERE:
 * every other test in this directory configures Google, so an OIDC-only
 * deployment — which is the whole point of the feature, and the shape a
 * self-hoster pointing Cellarion at their own IdP actually runs — was never
 * exercised at all. Leaving GOOGLE_CLIENT_ID unset below is what makes this
 * suite that deployment: the routes, the strategy and the providers endpoint
 * all have to work with no Google client configured.
 *
 * It does NOT prove the passport.initialize() placement. That call is now made
 * for either provider rather than only inside `if (GOOGLE_ENABLED)`, but
 * passport 0.7 tolerates authenticate() without it when sessions are off, so
 * the old placement passes these tests too — checked, not assumed. The move
 * stays because relying on undocumented tolerance is a latent dependency, not
 * because anything here can catch it.
 *
 * The rest pins that the OIDC strategy inherits the browser binding rather than
 * reimplementing it: a state on the way out, mirrored in a cookie, and a
 * callback refused before any code exchange when that cookie is absent.
 */

const ENV_UNDER_TEST = {
  JWT_SECRET: 'test-secret',
  FRONTEND_URL: 'https://cellar.example',
  OIDC_CLIENT_ID: 'test-oidc-client',
  OIDC_CLIENT_SECRET: 'test-oidc-secret',
  OIDC_AUTHORIZATION_URL: 'https://id.example/authorize',
  OIDC_TOKEN_URL: 'https://id.example/api/oidc/token',
  OIDC_USERINFO_URL: 'https://id.example/api/oidc/userinfo',
  OIDC_PROVIDER_NAME: 'Pocket ID',
  // Deliberately absent: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
};
const ENV_BEFORE = Object.fromEntries(
  [...Object.keys(ENV_UNDER_TEST), 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
    .map((key) => [key, process.env[key]])
);
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
Object.assign(process.env, ENV_UNDER_TEST);

afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Enough of a User model to carry a sign-in all the way to a session: findOne
// answers nothing (a first-time user), and save() records what was built.
jest.mock('../models/User', () => {
  const created = [];
  function User(doc) {
    Object.assign(this, doc);
    this._id = 'user-1';
  }
  User.prototype.save = async function save() { created.push(this); return this; };
  User.findOne = () => {
    const chain = { select: () => chain, lean: () => Promise.resolve(null), then: (r, j) => Promise.resolve(null).then(r, j) };
    return chain;
  };
  User.__created = created;
  return User;
});
jest.mock('../services/authTokens', () => {
  const actual = jest.requireActual('../services/authTokens');
  return { ...actual, issueTokens: jest.fn(async () => {}) };
});
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// Returns a promise: the route calls .catch() on it, so a bare jest.fn()
// throws inside the success path and turns a clean sign-in into server_error.
jest.mock('../services/pendingShares', () => ({ resolvePendingShares: jest.fn(async () => {}) }));

const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const passport = require('passport');

const oauthRouter = require('./oauth');
const User = require('../models/User');
const { issueTokens } = require('../services/authTokens');
const { DEFAULT_COOKIE_NAME: COOKIE_NAME } = require('../services/oauthStateStore');

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

function stateCookie(res) {
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return setCookie.filter(Boolean).find((c) => c.startsWith(`${COOKIE_NAME}=`));
}

describe('GET /api/auth/sso/providers', () => {
  it('advertises OIDC by name, and does not advertise unconfigured Google', async () => {
    const res = await get('/api/auth/sso/providers');
    expect(await res.json()).toEqual({ google: false, oidc: true, oidcName: 'Pocket ID' });
  });
});

describe('GET /api/auth/oidc', () => {
  it('redirects to the provider with state, PKCE and the openid scope', async () => {
    const res = await get('/api/auth/oidc');
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location'));
    expect(location.origin + location.pathname).toBe('https://id.example/authorize');
    expect(location.searchParams.get('client_id')).toBe('test-oidc-client');

    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');

    // `openid` is not optional: the userinfo endpoint is an OIDC feature and
    // providers refuse it without that scope.
    expect(location.searchParams.get('scope').split(' ')).toEqual(
      expect.arrayContaining(['openid', 'profile', 'email'])
    );

    // The binding is inherited from the shared store, not reimplemented.
    const cookie = stateCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`${COOKIE_NAME}=${state}.`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });
});

describe('GET /api/auth/oidc/callback', () => {
  it('refuses a code presented without the cookie that started the flow', async () => {
    const res = await get('/api/auth/oidc/callback?code=attacker-code&state=attacker-state');
    expect(res.headers.get('location')).toBe('https://cellar.example/login/callback?error=invalid_state');
  });

  it('reaches the token exchange for the flow it started', async () => {
    // The positive direction: every other assertion here is a refusal, and a
    // store that rejected unconditionally would satisfy all of them.
    const started = await get('/api/auth/oidc');
    const state = new URL(started.headers.get('location')).searchParams.get('state');
    const cookie = stateCookie(started).split(';')[0];

    const strategy = passport._strategy('oidc');
    const realExchange = strategy._oauth2.getOAuthAccessToken;
    let exchangedCode;
    strategy._oauth2.getOAuthAccessToken = (code, params, cb) => {
      exchangedCode = code;
      cb(new Error('token endpoint not called in tests'));
    };

    try {
      await get(`/api/auth/oidc/callback?code=any-code&state=${encodeURIComponent(state)}`, { cookie });
    } finally {
      strategy._oauth2.getOAuthAccessToken = realExchange;
    }

    expect(exchangedCode).toBe('any-code');
  });

  it('carries a sign-in all the way through userinfo to a session', async () => {
    // The end-to-end direction, which the other positive test does not reach:
    // state verified, code exchanged, userinfo fetched, claims mapped, account
    // created, session issued, browser sent to the SPA. Everything below the
    // token endpoint is real code; only the two network calls are stubbed.
    const started = await get('/api/auth/oidc');
    const state = new URL(started.headers.get('location')).searchParams.get('state');
    const cookie = stateCookie(started).split(';')[0];

    const strategy = passport._strategy('oidc');
    const realExchange = strategy._oauth2.getOAuthAccessToken;
    const realGet = strategy._oauth2.get;
    let userinfoUrl = null;
    strategy._oauth2.getOAuthAccessToken = (code, params, cb) => cb(null, 'an-access-token', null, {});
    strategy._oauth2.get = function (url, token, cb) {
      userinfoUrl = url;
      cb(null, JSON.stringify({
        sub: 'subject-abc',
        email: 'Erin@Example.COM',
        email_verified: true,
        name: 'Erin Example'
      }));
    };

    let res;
    try {
      res = await get(`/api/auth/oidc/callback?code=any-code&state=${encodeURIComponent(state)}`, { cookie });
    } finally {
      strategy._oauth2.getOAuthAccessToken = realExchange;
      strategy._oauth2.get = realGet;
    }

    // The token goes in the Authorization header, never on the URL. node-oauth
    // defaults this OFF, which made _oauth2.get() append ?access_token=… — the
    // defect a live sign-in found, since providers reject it and a token in a
    // URL lands in access logs. Asserted on the flag the strategy sets, because
    // the stub above replaces the code that consumes it.
    expect(strategy._oauth2._useAuthorizationHeaderForGET).toBe(true);
    expect(userinfoUrl).toBe('https://id.example/api/oidc/userinfo');
    expect(userinfoUrl).not.toContain('access_token');
    expect(res.headers.get('location')).toBe('https://cellar.example/login/callback');
    expect(issueTokens).toHaveBeenCalled();

    expect(User.__created).toHaveLength(1);
    const account = User.__created[0];
    expect(account.email).toBe('erin@example.com');       // case-folded
    expect(account.displayName).toBe('Erin Example');
    expect(account.roles).toEqual(['user']);              // nothing inherited from the IdP
    expect(account.authProviders).toEqual([
      { provider: 'oidc', providerId: 'subject-abc', issuer: 'https://id.example' }
    ]);
  });

  it('refuses userinfo that carries no sub claim', async () => {
    // sub is the only claim guaranteed stable and unique per issuer. Without it
    // there is nothing safe to key an account on — falling back to email would
    // key it on something the user can change at the provider.
    const started = await get('/api/auth/oidc');
    const state = new URL(started.headers.get('location')).searchParams.get('state');
    const cookie = stateCookie(started).split(';')[0];

    const strategy = passport._strategy('oidc');
    const realExchange = strategy._oauth2.getOAuthAccessToken;
    const realGet = strategy._oauth2.get;
    strategy._oauth2.getOAuthAccessToken = (code, params, cb) => cb(null, 'an-access-token', null, {});
    strategy._oauth2.get = (url, token, cb) => cb(null, JSON.stringify({ email: 'no-sub@example.com' }));

    try {
      const res = await get(`/api/auth/oidc/callback?code=any-code&state=${encodeURIComponent(state)}`, { cookie });
      expect(res.headers.get('location')).toBe('https://cellar.example/login/callback?error=server_error');
    } finally {
      strategy._oauth2.getOAuthAccessToken = realExchange;
      strategy._oauth2.get = realGet;
    }
  });
});
