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
const formPost = (path, obj) => fetch(`${base}/api/mcp/oauth${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

  test('an empty redirect_uris array is rejected', async () => {
    const r = await jsonPost('/register', { redirect_uris: [] });
    expect(r.status).toBe(400);
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
