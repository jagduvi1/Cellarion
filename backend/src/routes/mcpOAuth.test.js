/**
 * OAuth 2.1 authorization-server route — the security invariants an attacker
 * probes. Model DB methods are mocked (the full stateful happy-path handshake
 * is exercised for real against Mongo in the OAuth e2e); here we pin the branch
 * logic + HTTP contract that must hold regardless of DB state:
 *   - unknown client / unregistered redirect_uri never redirect (open-redirect guard)
 *   - PKCE is verified for REAL at /token (wrong verifier → invalid_grant)
 *   - a code bound to client A can't be redeemed by client B
 *   - a refresh token only refreshes its OWN client's connection
 *   - client authentication gates /token and /revoke
 * The crypto statics (hashToken, generateClientId, …) are the real transforms.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'https://cellarion.app';

const crypto = require('crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

jest.mock('../models/ApiToken', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  countDocuments: jest.fn(),
  generateToken: () => 'cel_' + require('crypto').randomBytes(32).toString('hex'),
  generateRefreshToken: () => require('crypto').randomBytes(32).toString('hex'),
  hashToken: (t) => require('crypto').createHash('sha256').update(t).digest('hex'),
}));
jest.mock('../models/OAuthClient', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(() => Promise.resolve()),
  generateClientId: () => 'mcpc_' + require('crypto').randomBytes(24).toString('hex'),
  generateClientSecret: () => require('crypto').randomBytes(32).toString('hex'),
  hashSecret: (s) => require('crypto').createHash('sha256').update(s).digest('hex'),
}));
jest.mock('../models/OAuthAuthCode', () => {
  const M = {
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
    generateCode: () => require('crypto').randomBytes(32).toString('hex'),
    hashCode: (c) => require('crypto').createHash('sha256').update(c).digest('hex'),
  };
  M.AUTH_CODE_TTL_MS = 5 * 60 * 1000;
  return M;
});
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/eventBus', () => ({ dropToken: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const ApiToken = require('../models/ApiToken');
const OAuthClient = require('../models/OAuthClient');
const OAuthAuthCode = require('../models/OAuthAuthCode');
const router = require('./mcpOAuth');

// RFC 7636 vector.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = 'https://cellarion.app/api/mcp';
const CLIENT = { _id: 'c1', clientId: 'mcpc_abc', clientName: 'Claude', redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'none' };
const USER = 'a'.repeat(24);
const jwtFor = (id = USER) => jwt.sign({ id, roles: ['user'] }, 'test-secret');

let server, base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp/oauth', router);
  server = http.createServer(app);
  server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => jest.clearAllMocks());

// The router is mounted at /api/mcp/oauth — helpers prepend that so callers use
// the short endpoint name.
const jsonPost = (path, body, headers = {}) => fetch(`${base}/api/mcp/oauth${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const formPost = (path, obj, headers = {}) => fetch(`${base}/api/mcp/oauth${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(obj).toString(),
});

describe('POST /register (DCR)', () => {
  test('valid public client → 201 with a client_id, no secret', async () => {
    OAuthClient.create.mockResolvedValue({ _id: 'c1', clientId: 'mcpc_x', clientName: 'Claude', createdAt: new Date(), grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] });
    const r = await jsonPost('/register', { redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' });
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.client_id).toBeTruthy();
    expect(b.client_secret).toBeUndefined(); // public client
  });

  test('a non-https, non-loopback redirect_uri is rejected', async () => {
    const r = await jsonPost('/register', { redirect_uris: ['http://evil.example/cb'] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_redirect_uri');
    expect(OAuthClient.create).not.toHaveBeenCalled();
  });

  // Security audit 2026-09-02 (D16-2): the COUNT was capped but each entry was
  // stored verbatim — one anonymous registration could park ~2 MB in Mongo.
  test('an over-long redirect_uri is rejected before anything is stored', async () => {
    const r = await jsonPost('/register', { redirect_uris: [`https://a.example/${'x'.repeat(2100)}`] });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/2048/);
  });

  test('an empty redirect_uris array is rejected', async () => {
    const r = await jsonPost('/register', { redirect_uris: [] });
    expect(r.status).toBe(400);
  });

  test("Gemini's custom connector registers its six callbacks", async () => {
    OAuthClient.create.mockImplementation(async (doc) => ({ _id: 'c1', createdAt: new Date(), ...doc }));
    const connector = 'user_bound_custom-mcp-1234567890-cellarion';
    const geminiCallbacks = ['oauth-redirect-sandbox', 'oauth-redirect-test', 'oauth-redirect']
      .flatMap((host) => ['r', 'a'].map((p) => `https://${host}.googleusercontent.com/${p}/${connector}`));
    const r = await jsonPost('/register', {
      redirect_uris: geminiCallbacks,
      client_name: 'Google',
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(r.status).toBe(201);
    expect((await r.json()).redirect_uris).toEqual(geminiCallbacks);
    expect(OAuthClient.create.mock.calls[0][0].redirectUris).toEqual(geminiCallbacks);
  });

  test('more than ten redirect_uris are refused before anything is stored', async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://a.example/cb${i}`);
    const r = await jsonPost('/register', { redirect_uris: uris });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_redirect_uri');
    expect(OAuthClient.create).not.toHaveBeenCalled();
  });

  test('redirect_uris whose lengths add up past the total are refused, each within its own cap', async () => {
    const uris = Array.from({ length: 6 }, (_, i) => `https://a.example/${i}${'x'.repeat(1990)}`);
    const r = await jsonPost('/register', { redirect_uris: uris });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/10240/);
    expect(OAuthClient.create).not.toHaveBeenCalled();
  });

  test('a new client is registered with a never-used TTL (expiresAt in the future)', async () => {
    OAuthClient.create.mockResolvedValue({ _id: 'c1', clientId: 'mcpc_x', clientName: null, createdAt: new Date(), grantTypes: [], responseTypes: [] });
    await jsonPost('/register', { redirect_uris: [REDIRECT] });
    const created = OAuthClient.create.mock.calls[0][0];
    expect(created.expiresAt).toBeInstanceOf(Date);
    // ~30 days out — armed, so an abandoned registration is auto-reaped.
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);
  });
});

describe('GET /authorize', () => {
  test('unknown client → 400, never a redirect', async () => {
    OAuthClient.findOne.mockResolvedValue(null);
    const r = await fetch(`${base}/api/mcp/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`, { redirect: 'manual' });
    expect(r.status).toBe(400);
  });

  test('unregistered redirect_uri → 400, never a redirect (open-redirect guard)', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await fetch(`${base}/api/mcp/oauth/authorize?client_id=${CLIENT.clientId}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`, { redirect: 'manual' });
    expect(r.status).toBe(400);
  });

  test('valid request → 302 to the frontend consent page carrying the params', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await fetch(`${base}/api/mcp/oauth/authorize?client_id=${CLIENT.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=read+write&state=xyz&resource=${encodeURIComponent(RESOURCE)}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location'));
    expect(loc.origin + loc.pathname).toBe('https://cellarion.app/connect-ai/authorize');
    expect(loc.searchParams.get('client_id')).toBe(CLIENT.clientId);
    expect(loc.searchParams.get('code_challenge')).toBe(CHALLENGE);
    expect(loc.searchParams.get('state')).toBe('xyz');
  });

  test('response_type≠code → 302 back to the client with an error (state preserved)', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await fetch(`${base}/api/mcp/oauth/authorize?client_id=${CLIENT.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=xyz`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location'));
    expect(loc.origin).toBe('https://claude.ai');
    expect(loc.searchParams.get('error')).toBe('unsupported_response_type');
    expect(loc.searchParams.get('state')).toBe('xyz');
  });

  test('missing PKCE → 302 back with invalid_request', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await fetch(`${base}/api/mcp/oauth/authorize?client_id=${CLIENT.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get('location')).searchParams.get('error')).toBe('invalid_request');
  });
});

describe('POST /approve (consent, JWT-only)', () => {
  test('requires a logged-in user (no JWT → 401)', async () => {
    const r = await jsonPost('/approve', { client_id: CLIENT.clientId, redirect_uri: REDIRECT, approved: true });
    expect(r.status).toBe(401);
  });

  test('approval mints a single-use code and returns the redirect with it', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.create.mockResolvedValue({});
    const r = await jsonPost('/approve', {
      client_id: CLIENT.clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
      code_challenge_method: 'S256', scope: 'read write', state: 'xyz', resource: RESOURCE, approved: true,
    }, { Authorization: `Bearer ${jwtFor()}` });
    expect(r.status).toBe(200);
    const loc = new URL((await r.json()).redirect);
    const rawCode = loc.searchParams.get('code');
    expect(rawCode).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('xyz');
    // The code is bound to THIS user + client + challenge + granted scopes.
    const stored = OAuthAuthCode.create.mock.calls[0][0];
    expect(stored.user).toBe(USER);
    expect(stored.clientId).toBe(CLIENT.clientId);
    expect(stored.codeChallenge).toBe(CHALLENGE);
    expect(stored.scopes).toEqual(['read', 'write']);
    // Only the HASH is stored — the raw code lives only in the redirect.
    expect(stored.codeHash).toBe(sha256(rawCode));
    expect(stored.codeHash).not.toBe(rawCode);
  });

  test('denial returns an access_denied redirect and mints NO code', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await jsonPost('/approve', { client_id: CLIENT.clientId, redirect_uri: REDIRECT, state: 'xyz', approved: false },
      { Authorization: `Bearer ${jwtFor()}` });
    expect(r.status).toBe(200);
    expect(new URL((await r.json()).redirect).searchParams.get('error')).toBe('access_denied');
    expect(OAuthAuthCode.create).not.toHaveBeenCalled();
  });

  test('an unregistered redirect_uri is rejected even with a valid session', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await jsonPost('/approve', { client_id: CLIENT.clientId, redirect_uri: 'https://evil.example/cb', approved: true },
      { Authorization: `Bearer ${jwtFor()}` });
    expect(r.status).toBe(400);
    expect(OAuthAuthCode.create).not.toHaveBeenCalled();
  });

  // ── The user's scope choice (consent-page picker) ─────────────────────────
  const approveWith = (extra) => jsonPost('/approve', {
    client_id: CLIENT.clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
    code_challenge_method: 'S256', scope: 'read consume write', resource: RESOURCE, approved: true, ...extra,
  }, { Authorization: `Bearer ${jwtFor()}` });

  test('the user may NARROW the grant: chosen ["read"] mints a read-only code', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.create.mockResolvedValue({});
    const r = await approveWith({ scopes: ['read'] });
    expect(r.status).toBe(200);
    expect(OAuthAuthCode.create.mock.calls[0][0].scopes).toEqual(['read']);
  });

  test('the choice cannot EXCEED the client request: write when only read was requested → 400', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await approveWith({ scope: 'read', scopes: ['read', 'write'] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not requested/);
    expect(OAuthAuthCode.create).not.toHaveBeenCalled();
  });

  test('read is the floor: a choice without it → 400', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await approveWith({ scopes: ['consume', 'write'] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/read scope is required/);
    expect(OAuthAuthCode.create).not.toHaveBeenCalled();
  });

  test.each([[[]], ['not-an-array'], [[42]]])('malformed scopes (%j) → 400', async (scopes) => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await approveWith({ scopes });
    expect(r.status).toBe(400);
    expect(OAuthAuthCode.create).not.toHaveBeenCalled();
  });

  test('absent scopes keeps the previous behavior: the full requested∩grantable set', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.create.mockResolvedValue({});
    const r = await approveWith({});
    expect(r.status).toBe(200);
    expect(OAuthAuthCode.create.mock.calls[0][0].scopes).toEqual(['read', 'consume', 'write']);
  });
});

describe('POST /token — authorization_code', () => {
  const codeDoc = (over = {}) => ({
    clientId: CLIENT.clientId, redirectUri: REDIRECT, codeChallenge: CHALLENGE,
    scopes: ['read', 'write'], resource: RESOURCE, user: USER, ...over,
  });

  test('unknown client → 401 invalid_client', async () => {
    OAuthClient.findOne.mockResolvedValue(null);
    const r = await formPost('/token', { grant_type: 'authorization_code', client_id: 'nope', code: 'x', code_verifier: VERIFIER });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('invalid_client');
  });

  test('a wrong PKCE verifier is rejected (invalid_grant) — verified for real', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.findOneAndUpdate.mockResolvedValue(codeDoc()); // code claimed
    const r = await formPost('/token', { grant_type: 'authorization_code', client_id: CLIENT.clientId, code: 'rawcode', code_verifier: 'a'.repeat(43), redirect_uri: REDIRECT });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
    expect(ApiToken.create).not.toHaveBeenCalled();
  });

  test('a code issued to a different client cannot be redeemed', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.findOneAndUpdate.mockResolvedValue(codeDoc({ clientId: 'someone_else' }));
    const r = await formPost('/token', { grant_type: 'authorization_code', client_id: CLIENT.clientId, code: 'rawcode', code_verifier: VERIFIER, redirect_uri: REDIRECT });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
  });

  test('an already-used / expired code → invalid_grant', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.findOneAndUpdate.mockResolvedValue(null); // claim found nothing
    const r = await formPost('/token', { grant_type: 'authorization_code', client_id: CLIENT.clientId, code: 'rawcode', code_verifier: VERIFIER, redirect_uri: REDIRECT });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
  });

  test('valid code + verifier → mints an OAuth cel_ token bound to the user/scopes', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.findOneAndUpdate.mockResolvedValue(codeDoc());
    ApiToken.countDocuments.mockResolvedValue(0);
    ApiToken.create.mockResolvedValue({ _id: 't1' });
    const r = await formPost('/token', { grant_type: 'authorization_code', client_id: CLIENT.clientId, code: 'rawcode', code_verifier: VERIFIER, redirect_uri: REDIRECT, resource: RESOURCE });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.access_token).toMatch(/^cel_/);
    expect(b.token_type).toBe('bearer');
    expect(b.refresh_token).toBeTruthy();
    expect(b.scope).toBe('read write');
    const created = ApiToken.create.mock.calls[0][0];
    expect(created).toMatchObject({ user: USER, origin: 'oauth', oauthClientId: CLIENT.clientId, scopes: ['read', 'write'] });
    expect(created.tokenHash).toBeTruthy();
    expect(created.expiresAt).toBeInstanceOf(Date);
    // First successful exchange makes the client permanent: clear the never-used TTL (M-6).
    const upd = OAuthClient.updateOne.mock.calls[0];
    expect(upd[0]).toEqual({ _id: CLIENT._id });
    expect(upd[1].$unset).toEqual({ expiresAt: '' });
  });

  test('the connection cap is enforced', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    OAuthAuthCode.findOneAndUpdate.mockResolvedValue(codeDoc());
    ApiToken.countDocuments.mockResolvedValue(20); // at cap
    const r = await formPost('/token', { grant_type: 'authorization_code', client_id: CLIENT.clientId, code: 'rawcode', code_verifier: VERIFIER, redirect_uri: REDIRECT });
    expect(r.status).toBe(400);
    expect(ApiToken.create).not.toHaveBeenCalled();
  });
});

describe('POST /token — refresh_token (rotation)', () => {
  test('rotates both tokens for the owning client', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const raw = 'refreshraw';
    ApiToken.findOne.mockResolvedValue({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256(raw), scopes: ['read'] });
    ApiToken.findOneAndUpdate.mockResolvedValue({ _id: 't1', scopes: ['read'] });
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: raw });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.access_token).toMatch(/^cel_/);
    expect(b.refresh_token).toBeTruthy();
    // The row is updated with fresh hashes (rotation).
    const setArg = ApiToken.findOneAndUpdate.mock.calls[0][1].$set;
    expect(setArg.tokenHash).toBeTruthy();
    expect(setArg.refreshTokenHash).toBeTruthy();
  });

  test('an unknown refresh token → invalid_grant, nothing revoked', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    ApiToken.findOne.mockResolvedValue(null); // matches neither current nor prev
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'dead' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
  });

  test('REUSE of an already-rotated refresh token revokes the whole connection', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const save = jest.fn().mockResolvedValue();
    // 1st findOne (by current hash) → miss; 2nd (by prevRefreshTokenHash) → hit.
    ApiToken.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 't1', oauthClientId: CLIENT.clientId, save });
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'spent' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
    // The stolen-token signal kills the connection — both parties must re-auth.
    expect(save).toHaveBeenCalled();
    expect(ApiToken.findOne.mock.calls[1][0]).toMatchObject({ prevRefreshTokenHash: sha256('spent'), origin: 'oauth', oauthClientId: CLIENT.clientId });
  });

  test('rotation records the spent refresh hash so a later replay is detectable', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const raw = 'currentraw';
    ApiToken.findOne.mockResolvedValue({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256(raw), scopes: ['read'] });
    ApiToken.findOneAndUpdate.mockResolvedValue({ _id: 't1', scopes: ['read'] });
    await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: raw });
    expect(ApiToken.findOneAndUpdate.mock.calls[0][1].$set.prevRefreshTokenHash).toBe(sha256(raw));
  });

  test('a client cannot refresh ANOTHER client\'s token', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    ApiToken.findOne.mockResolvedValue({ _id: 't1', oauthClientId: 'other_client', refreshTokenHash: sha256('r') });
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'r' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
    expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('an unsupported grant_type → 400 unsupported_grant_type', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await formPost('/token', { grant_type: 'client_credentials', client_id: CLIENT.clientId });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('unsupported_grant_type');
  });
});

describe('POST /revoke', () => {
  test('unknown client → 401', async () => {
    OAuthClient.findOne.mockResolvedValue(null);
    const r = await formPost('/revoke', { client_id: 'nope', token: 'x' });
    expect(r.status).toBe(401);
  });

  test('revokes the matching token and always 200s', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const save = jest.fn().mockResolvedValue();
    ApiToken.findOne.mockResolvedValue({ _id: 't1', save });
    const r = await formPost('/revoke', { client_id: CLIENT.clientId, token: 'cel_whatever' });
    expect(r.status).toBe(200);
    expect(save).toHaveBeenCalled();
  });

  test('an unknown token still 200s (RFC 7009)', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    ApiToken.findOne.mockResolvedValue(null);
    const r = await formPost('/revoke', { client_id: CLIENT.clientId, token: 'nope' });
    expect(r.status).toBe(200);
  });
});

// Security audit 2026-07-25 L-2. These endpoints declare a urlencoded parser
// (which only ever yields strings), but app.js mounts express.json() on the
// /api/mcp PREFIX — and that matches /api/mcp/oauth/* — so a caller sending
// Content-Type: application/json can put an object where a token string
// belongs. Hashing it threw a TypeError that surfaced as a 500 with a stack
// trace instead of the RFC-shaped error. Not exploitable (the throw happens
// before any query, so no operator reaches Mongo) — but a 500 on an
// unauthenticated endpoint is both a bad contract and log noise.
describe('non-string credentials are rejected, never 500 (L-2)', () => {
  const NON_STRINGS = [
    ['an operator object', { $ne: null }],
    ['an array',           ['x']],
    ['a number',           1234],
  ];

  test.each(NON_STRINGS)('/token authorization_code: %s code → 400 invalid_request', async (_l, code) => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await jsonPost('/token', {
      grant_type: 'authorization_code', client_id: CLIENT.clientId, code, code_verifier: VERIFIER,
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_request');
    // Never reached the code lookup.
    expect(OAuthAuthCode.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each(NON_STRINGS)('/token refresh_token: %s refresh_token → 400 invalid_request', async (_l, refresh_token) => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await jsonPost('/token', {
      grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token,
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_request');
    expect(ApiToken.findOne).not.toHaveBeenCalled();
  });

  test.each(NON_STRINGS)('/revoke: %s token → 200 (RFC 7009) and no lookup', async (_l, token) => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const r = await jsonPost('/revoke', { client_id: CLIENT.clientId, token });
    // RFC 7009 §2.2: an invalid token is still a success — just never a 500.
    expect(r.status).toBe(200);
    expect(ApiToken.findOne).not.toHaveBeenCalled();
  });
});

describe('POST /token — refresh_token (the grace window after a rotation)', () => {
  // A spent refresh token presented INSIDE the grace window is a lost
  // rotation response or a second process of the same client, not a theft
  // (usage check 2026-10-09: a connector replayed its revoked token every ten
  // minutes for a day and a half). The connection rotates on from where it is.
  test('inside the window the spent token rotates the connection on; nothing is revoked', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const save = jest.fn().mockResolvedValue();
    ApiToken.findOne
      .mockResolvedValueOnce(null) // not the current token
      .mockResolvedValueOnce({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256('current'), refreshRotatedAt: new Date(Date.now() - 10 * 1000), save });
    ApiToken.findOneAndUpdate.mockResolvedValue({ _id: 't1', scopes: ['read'] });
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'spent' });
    expect(r.status).toBe(200);
    expect((await r.json()).refresh_token).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    const [filter, update] = ApiToken.findOneAndUpdate.mock.calls[0];
    // Pinned on the spent hash it presented — a concurrent real rotation wins.
    expect(filter).toMatchObject({ _id: 't1', prevRefreshTokenHash: sha256('spent'), revokedAt: null });
    expect(update.$set.tokenHash).toBeTruthy();
    expect(update.$set.refreshTokenHash).toBeTruthy();
    // The successor the retrying client never received becomes the spent
    // one, so presenting it later (outside the window) trips reuse detection
    // like any replay; the rotation time is NOT moved, so a spent token cannot
    // be kept alive by replaying it (release audit 2026-10-09, M2).
    expect(update.$set.prevRefreshTokenHash).toBe(sha256('current'));
    expect(update.$set.refreshRotatedAt).toBeUndefined();
  });

  test('outside the window it is reuse: the connection is revoked', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const save = jest.fn().mockResolvedValue();
    ApiToken.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 't1', oauthClientId: CLIENT.clientId, refreshRotatedAt: new Date(Date.now() - 5 * 60 * 1000), save });
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'spent' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
    expect(save).toHaveBeenCalled();
    expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a connection rotated before the field existed has no window', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const save = jest.fn().mockResolvedValue();
    ApiToken.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 't1', oauthClientId: CLIENT.clientId, save }); // no refreshRotatedAt
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'spent' });
    expect(r.status).toBe(400);
    expect(save).toHaveBeenCalled();
  });

  test('a real rotation stamps the time the window is measured from', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    ApiToken.findOne.mockResolvedValue({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256('current'), scopes: ['read'] });
    ApiToken.findOneAndUpdate.mockResolvedValue({ _id: 't1', scopes: ['read'] });
    await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'current' });
    expect(ApiToken.findOneAndUpdate.mock.calls[0][1].$set.refreshRotatedAt).toBeInstanceOf(Date);
  });
});

describe('POST /token — refusals are logged', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  test('a refused refresh names the client, the grant and the reason — never the token', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    ApiToken.findOne.mockResolvedValue(null);
    await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'secret-refresh-value' });
    const line = warn.mock.calls.find((c) => String(c[0]).includes('token request refused'));
    expect(line).toBeTruthy();
    expect(line[1]).toMatchObject({ status: 400, error: 'invalid_grant', grant: 'refresh_token', client: 'Claude' });
    expect(JSON.stringify(line)).not.toContain('secret-refresh-value');
  });

  test('an unknown client is logged without a client name', async () => {
    OAuthClient.findOne.mockResolvedValue(null);
    await formPost('/token', { grant_type: 'refresh_token', client_id: 'mcpc_nobody', refresh_token: 'x' });
    const line = warn.mock.calls.find((c) => String(c[0]).includes('token request refused'));
    expect(line[1]).toMatchObject({ status: 401, error: 'invalid_client', client: null });
  });

  test('a successful exchange logs nothing', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    ApiToken.findOne.mockResolvedValue({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256('ok'), scopes: ['read'] });
    ApiToken.findOneAndUpdate.mockResolvedValue({ _id: 't1', scopes: ['read'] });
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'ok' });
    expect(r.status).toBe(200);
    expect(warn.mock.calls.find((c) => String(c[0]).includes('token request refused'))).toBeUndefined();
  });
});

describe('POST /token — the grace window never hides a theft for good (release audit 2026-10-09, M2)', () => {
  test('a graced retry that loses the race to a real rotation gets invalid_grant, nothing revoked', async () => {
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const save = jest.fn().mockResolvedValue();
    ApiToken.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256('current'), refreshRotatedAt: new Date(Date.now() - 5 * 1000), save });
    ApiToken.findOneAndUpdate.mockResolvedValue(null); // the pinned prev hash moved under us
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'spent' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
    expect(save).not.toHaveBeenCalled();
  });

  test('the successor a graced retry displaced, presented after the window, is reuse: the connection is revoked', async () => {
    // After the graced rotation the row holds { current: R3, prev: R2 } with
    // the rotation time still that of the real rotation. The other holder
    // (the thief, or the owner) presents R2 a few minutes later.
    OAuthClient.findOne.mockResolvedValue(CLIENT);
    const save = jest.fn().mockResolvedValue();
    ApiToken.findOne
      .mockResolvedValueOnce(null) // R2 is not current
      .mockResolvedValueOnce({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256('R3'), prevRefreshTokenHash: sha256('R2'), refreshRotatedAt: new Date(Date.now() - 5 * 60 * 1000), save });
    const r = await formPost('/token', { grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: 'R2' });
    expect(r.status).toBe(400);
    expect(save).toHaveBeenCalled(); // revokedAt set
    expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

// RFC 6749 §2.3.1: a client issued a secret may authenticate with HTTP Basic.
// Gemini's custom connector registers with client_secret_basic and then sends
// its credentials in the Authorization header, not the body.
describe('client_secret_basic — client credentials in the Authorization header', () => {
  const GEMINI_REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-test';
  const BASIC_SECRET = crypto.randomBytes(32).toString('hex');
  const POST_SECRET = crypto.randomBytes(32).toString('hex');
  const BASIC_CLIENT = {
    _id: 'c2', clientId: 'mcpc_basic', clientName: 'Gemini', redirectUris: [GEMINI_REDIRECT],
    tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: sha256(BASIC_SECRET),
  };
  const POST_CLIENT = {
    _id: 'c3', clientId: 'mcpc_post', clientName: 'Poster', redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'client_secret_post', clientSecretHash: sha256(POST_SECRET),
  };
  // Each part is application/x-www-form-urlencoded before joining (RFC 6749 §2.3.1).
  const form = (s) => encodeURIComponent(s).replace(/%20/g, '+');
  const basicAuth = (id, secret) => `Basic ${Buffer.from(`${form(id)}:${form(secret)}`, 'utf8').toString('base64')}`;
  const b64 = (raw) => `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  const CHALLENGE_HEADER = 'Basic realm="Cellarion"';
  const codeDoc = (client = BASIC_CLIENT, over = {}) => ({
    clientId: client.clientId, redirectUri: client.redirectUris[0], codeChallenge: CHALLENGE,
    scopes: ['read'], resource: RESOURCE, user: USER, ...over,
  });
  const exchange = (client = BASIC_CLIENT, extra = {}) => ({
    grant_type: 'authorization_code', code: 'rawcode', code_verifier: VERIFIER, redirect_uri: client.redirectUris[0], ...extra,
  });
  const issuable = (client = BASIC_CLIENT) => {
    OAuthClient.findOne.mockResolvedValue(client);
    OAuthAuthCode.findOneAndUpdate.mockResolvedValue(codeDoc(client));
    ApiToken.countDocuments.mockResolvedValue(0);
    ApiToken.create.mockResolvedValue({ _id: 't1' });
  };
  const expectRefused = async (r, { challenge }) => {
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('invalid_client');
    expect(r.headers.get('www-authenticate')).toBe(challenge ? CHALLENGE_HEADER : null);
  };

  let errorSpy;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => {
    // No path in this block may end in the 500 catch.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe('POST /register', () => {
    test('client_secret_basic → 201 with a secret shown once; the method and only the hash are stored', async () => {
      OAuthClient.create.mockImplementation(async (doc) => ({ _id: 'c2', createdAt: new Date(), ...doc }));
      const r = await jsonPost('/register', { redirect_uris: [GEMINI_REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
      expect(r.status).toBe(201);
      expect(r.headers.get('cache-control')).toBe('no-store');
      const b = await r.json();
      expect(b.client_id).toMatch(/^mcpc_/);
      expect(b.client_secret).toMatch(/^[a-f0-9]{64}$/);
      expect(b.client_secret_expires_at).toBe(0);
      expect(b.token_endpoint_auth_method).toBe('client_secret_basic');
      const created = OAuthClient.create.mock.calls[0][0];
      expect(created.tokenEndpointAuthMethod).toBe('client_secret_basic');
      expect(created.clientSecretHash).toBe(sha256(b.client_secret));
      expect(JSON.stringify(created)).not.toContain(b.client_secret);
      // Still reaped after 30 days if it never completes an exchange.
      expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);
    });

    test('client_secret_post still registers with a secret; an unsupported method is still refused', async () => {
      OAuthClient.create.mockImplementation(async (doc) => ({ _id: 'c3', createdAt: new Date(), ...doc }));
      const ok = await jsonPost('/register', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' });
      expect(ok.status).toBe(201);
      expect((await ok.json()).client_secret).toMatch(/^[a-f0-9]{64}$/);
      OAuthClient.create.mockClear();
      const bad = await jsonPost('/register', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe('invalid_client_metadata');
      expect(OAuthClient.create).not.toHaveBeenCalled();
    });

    test('a basic client is held to the same redirect rules', async () => {
      const r = await jsonPost('/register', { redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'client_secret_basic' });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('invalid_redirect_uri');
      expect(OAuthClient.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /token', () => {
    test('a Basic header alone (no client_id in the body) + PKCE → tokens', async () => {
      issuable();
      const r = await formPost('/token', exchange(), { Authorization: basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET) });
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b.access_token).toMatch(/^cel_/);
      expect(b.refresh_token).toBeTruthy();
      expect(OAuthClient.findOne).toHaveBeenCalledWith({ clientId: BASIC_CLIENT.clientId });
      expect(ApiToken.create.mock.calls[0][0]).toMatchObject({ oauthClientId: BASIC_CLIENT.clientId, user: USER });
    });

    test('an id and a secret that need form-encoding are decoded after the split', async () => {
      const id = 'mcpc_needs:enc oding+';
      const secret = 'p@ss: w%rd/+=é';
      const client = { ...BASIC_CLIENT, clientId: id, clientSecretHash: sha256(secret) };
      issuable(client);
      const r = await formPost('/token', exchange(client), { Authorization: basicAuth(id, secret) });
      expect(r.status).toBe(200);
      expect(OAuthClient.findOne).toHaveBeenCalledWith({ clientId: id });
    });

    test('the same id in the header and the body is fine', async () => {
      issuable();
      const r = await formPost('/token', exchange(BASIC_CLIENT, { client_id: BASIC_CLIENT.clientId }),
        { Authorization: basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET) });
      expect(r.status).toBe(200);
    });

    test('a confidential client may use either method: basic-registered with the secret in the body → tokens', async () => {
      issuable();
      const r = await formPost('/token', exchange(BASIC_CLIENT, { client_id: BASIC_CLIENT.clientId, client_secret: BASIC_SECRET }));
      expect(r.status).toBe(200);
    });

    test('… and post-registered with a Basic header → tokens', async () => {
      issuable(POST_CLIENT);
      const r = await formPost('/token', exchange(POST_CLIENT), { Authorization: basicAuth(POST_CLIENT.clientId, POST_SECRET) });
      expect(r.status).toBe(200);
    });

    test('a wrong secret in the header → 401 invalid_client with a Basic challenge; no code is claimed', async () => {
      issuable();
      const r = await formPost('/token', exchange(), { Authorization: basicAuth(BASIC_CLIENT.clientId, 'not-the-secret') });
      await expectRefused(r, { challenge: true });
      expect(OAuthAuthCode.findOneAndUpdate).not.toHaveBeenCalled();
      expect(ApiToken.create).not.toHaveBeenCalled();
    });

    test('a wrong secret in the body → 401 without a challenge', async () => {
      issuable();
      const r = await formPost('/token', exchange(BASIC_CLIENT, { client_id: BASIC_CLIENT.clientId, client_secret: 'not-the-secret' }));
      await expectRefused(r, { challenge: false });
      expect(ApiToken.create).not.toHaveBeenCalled();
    });

    test('a confidential client without its secret is refused: header with an empty secret, or the id alone in the body', async () => {
      issuable();
      await expectRefused(await formPost('/token', exchange(), { Authorization: basicAuth(BASIC_CLIENT.clientId, '') }), { challenge: true });
      await expectRefused(await formPost('/token', exchange(BASIC_CLIENT, { client_id: BASIC_CLIENT.clientId })), { challenge: false });
      expect(ApiToken.create).not.toHaveBeenCalled();
    });

    test('a header id that differs from the body id is refused before any lookup', async () => {
      issuable();
      const r = await formPost('/token', exchange(BASIC_CLIENT, { client_id: POST_CLIENT.clientId }),
        { Authorization: basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET) });
      await expectRefused(r, { challenge: true });
      expect(OAuthClient.findOne).not.toHaveBeenCalled();
    });

    test.each([
      ['the header right, the body wrong', BASIC_SECRET, 'not-the-secret'],
      ['the header wrong, the body right', 'not-the-secret', BASIC_SECRET],
    ])('a header secret that differs from the body secret is refused (%s)', async (_l, headerSecret, bodySecret) => {
      issuable();
      const r = await formPost('/token', exchange(BASIC_CLIENT, { client_secret: bodySecret }),
        { Authorization: basicAuth(BASIC_CLIENT.clientId, headerSecret) });
      await expectRefused(r, { challenge: true });
      expect(OAuthClient.findOne).not.toHaveBeenCalled();
    });

    test.each([
      ['not base64', 'Basic %%%not-base64%%%'],
      ['no colon', b64('mcpc_basic')],
      ['an empty id', b64(`:${BASIC_SECRET}`)],
      ['broken percent-encoding', b64(`mcpc_basic:%zz${BASIC_SECRET}`)],
      // 7,700 bytes → a header of 10,274 characters, inside Node's 16 kB limit.
      ['a 10 kB header', b64(`mcpc_basic:${'s'.repeat(7689)}`)],
      ['the scheme alone', 'Basic'],
    ])('a malformed header (%s) → 401 invalid_client, never a 500', async (_l, header) => {
      issuable();
      // Valid credentials in the body beside it do not rescue a broken header.
      const r = await formPost('/token', exchange(BASIC_CLIENT, { client_id: BASIC_CLIENT.clientId, client_secret: BASIC_SECRET }),
        { Authorization: header });
      await expectRefused(r, { challenge: true });
      expect(OAuthClient.findOne).not.toHaveBeenCalled();
    });

    test('PKCE is still required for a Basic client: no verifier → invalid_request, a wrong one → invalid_grant', async () => {
      issuable();
      const auth = { Authorization: basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET) };
      const missing = await formPost('/token', exchange(BASIC_CLIENT, { code_verifier: '' }), auth);
      expect(missing.status).toBe(400);
      expect((await missing.json()).error).toBe('invalid_request');
      const wrong = await formPost('/token', exchange(BASIC_CLIENT, { code_verifier: 'a'.repeat(43) }), auth);
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).error).toBe('invalid_grant');
      expect(ApiToken.create).not.toHaveBeenCalled();
    });

    test('a Basic client cannot refresh another client\'s connection', async () => {
      OAuthClient.findOne.mockResolvedValue(BASIC_CLIENT);
      ApiToken.findOne.mockResolvedValue({ _id: 't1', oauthClientId: CLIENT.clientId, refreshTokenHash: sha256('r') });
      const r = await formPost('/token', { grant_type: 'refresh_token', refresh_token: 'r' },
        { Authorization: basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET) });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('invalid_grant');
      expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('POST /revoke', () => {
    test('a Basic header authenticates the revocation of the client\'s own token', async () => {
      OAuthClient.findOne.mockResolvedValue(BASIC_CLIENT);
      const save = jest.fn().mockResolvedValue();
      ApiToken.findOne.mockResolvedValue({ _id: 't1', save });
      const r = await formPost('/revoke', { token: 'cel_whatever' }, { Authorization: basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET) });
      expect(r.status).toBe(200);
      expect(save).toHaveBeenCalled();
      expect(ApiToken.findOne.mock.calls[0][0]).toMatchObject({ oauthClientId: BASIC_CLIENT.clientId, origin: 'oauth' });
    });

    test('a wrong secret in the header → 401 with a Basic challenge; nothing is looked up', async () => {
      OAuthClient.findOne.mockResolvedValue(BASIC_CLIENT);
      const r = await formPost('/revoke', { token: 'cel_whatever' }, { Authorization: basicAuth(BASIC_CLIENT.clientId, 'not-the-secret') });
      await expectRefused(r, { challenge: true });
      expect(ApiToken.findOne).not.toHaveBeenCalled();
    });

    test('a malformed header → 401 with a Basic challenge', async () => {
      OAuthClient.findOne.mockResolvedValue(BASIC_CLIENT);
      const r = await formPost('/revoke', { token: 'cel_whatever' }, { Authorization: 'Basic %%%' });
      await expectRefused(r, { challenge: true });
      expect(OAuthClient.findOne).not.toHaveBeenCalled();
    });

    test('a header secret that differs from the body secret is refused', async () => {
      OAuthClient.findOne.mockResolvedValue(BASIC_CLIENT);
      const r = await formPost('/revoke', { token: 'cel_whatever', client_secret: 'not-the-secret' },
        { Authorization: basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET) });
      await expectRefused(r, { challenge: true });
      expect(ApiToken.findOne).not.toHaveBeenCalled();
    });

    test('a wrong secret in the body → 401 without a challenge', async () => {
      OAuthClient.findOne.mockResolvedValue(BASIC_CLIENT);
      const r = await formPost('/revoke', { token: 'cel_whatever', client_id: BASIC_CLIENT.clientId, client_secret: 'not-the-secret' });
      await expectRefused(r, { challenge: false });
    });
  });

  describe('public clients', () => {
    test('a Basic header with the id and an empty secret → tokens', async () => {
      issuable(CLIENT);
      const r = await formPost('/token', exchange(CLIENT), { Authorization: basicAuth(CLIENT.clientId, '') });
      expect(r.status).toBe(200);
      expect(OAuthClient.findOne).toHaveBeenCalledWith({ clientId: CLIENT.clientId });
    });

    test('no header: the body client_id alone → tokens', async () => {
      issuable(CLIENT);
      const r = await formPost('/token', exchange(CLIENT, { client_id: CLIENT.clientId }));
      expect(r.status).toBe(200);
      expect(r.headers.get('www-authenticate')).toBeNull();
    });

    test('an Authorization header of another scheme is not client authentication: it is ignored', async () => {
      issuable(CLIENT);
      const r = await formPost('/token', exchange(CLIENT, { client_id: CLIENT.clientId }), { Authorization: 'Bearer cel_unrelated' });
      expect(r.status).toBe(200);
    });

    test('an unknown client id in a Basic header → 401 with a challenge', async () => {
      OAuthClient.findOne.mockResolvedValue(null);
      await expectRefused(await formPost('/token', exchange(CLIENT), { Authorization: basicAuth('mcpc_nobody', '') }), { challenge: true });
    });
  });

  describe('the refusal log', () => {
    let warn;
    beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); });
    const refusals = () => warn.mock.calls.filter((c) => String(c[0]).includes('token request refused'));

    test('a refused Basic attempt is logged without the header, the base64 or either secret', async () => {
      issuable();
      const presented = 'wrong-secret-value';
      const header = basicAuth(BASIC_CLIENT.clientId, presented);
      await formPost('/token', exchange(BASIC_CLIENT, { client_id: BASIC_CLIENT.clientId }), { Authorization: header });
      const lines = refusals();
      expect(lines).toHaveLength(1);
      expect(lines[0][1]).toMatchObject({ status: 401, error: 'invalid_client', client: null, basicAuth: true });
      const logged = JSON.stringify(warn.mock.calls);
      for (const secretish of [presented, BASIC_SECRET, header, header.slice('Basic '.length), 'Basic ']) {
        expect(logged).not.toContain(secretish);
      }
    });

    test('a refusal after a good Basic authentication names the client, never the secret', async () => {
      issuable();
      OAuthAuthCode.findOneAndUpdate.mockResolvedValue(null); // the code is spent
      const header = basicAuth(BASIC_CLIENT.clientId, BASIC_SECRET);
      await formPost('/token', exchange(), { Authorization: header });
      const lines = refusals();
      expect(lines).toHaveLength(1);
      expect(lines[0][1]).toMatchObject({ status: 400, error: 'invalid_grant', client: 'Gemini', basicAuth: true });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(BASIC_SECRET);
      expect(logged).not.toContain(header.slice('Basic '.length));
    });
  });
});
