/**
 * HTTP Basic client authentication (RFC 6749 §2.3.1) on the REAL app against
 * a REAL MongoDB: every mount, parser, limiter and middleware in app.js runs
 * in front of /api/mcp/oauth, as in production.
 *
 * WHY THIS TEST EXISTS:
 * The token and revocation endpoints read client credentials from an
 * `Authorization: Basic` header. Nothing in front of them may take that header
 * for a member's credential or refuse it first: requireAuth and optionalAuth
 * read only `Bearer`, the rate limiters key on the address, and no router
 * mounted before /api/mcp/oauth matches its paths. The proof is the answer
 * itself: a Basic client gets its tokens, and a wrong secret is refused in the
 * route's own RFC 6749 §5.2 shape (`invalid_client` with a Basic challenge),
 * not a middleware's. The registration row is read back from MongoDB, so the
 * model's enum and the stored hash are checked too. Mocked models cannot show
 * any of this, which is why it runs on MongoDB.
 *
 * Every request stays on the test stack: FRONTEND_URL is a dead local
 * address (a route that redirects points there) and fetch follows no
 * redirect.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_oauth_basic`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'oauth-basic-'.repeat(5);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'oauth-basic-meili-key-0123456789';
process.env.MEILI_URL = 'http://127.0.0.1:1';
process.env.FRONTEND_URL = 'http://127.0.0.1:9';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here
// searches through it.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const crypto = require('crypto');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { assertContractDb } = require('../openapi/contract.fixtures');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_oauth_basic'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/mcpOAuth.basic.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// RFC 7636 Appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const GEMINI_REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-test';
const PUBLIC_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const form = (s) => encodeURIComponent(s).replace(/%20/g, '+');
const basicAuth = (id, secret) => `Basic ${Buffer.from(`${form(id)}:${form(secret)}`, 'utf8').toString('base64')}`;

describeWithMongo('HTTP Basic client authentication on the real app (real MongoDB)', () => {
  let server; let base; let memberJwt; let OAuthClient; let ApiToken;

  beforeAll(async () => {
    await mongoose.connect(URI);
    assertContractDb();
    await mongoose.connection.dropDatabase();
    OAuthClient = require('../models/OAuthClient');
    ApiToken = require('../models/ApiToken');
    const User = require('../models/User');
    const member = await User.create({ username: 'basicmember', email: 'basic@contract.test', password: 'Contract-Test-Passw0rd!' });
    memberJwt = jwt.sign({ id: String(member._id), roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    server = http.createServer(require('../app')).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  }, 180000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  let ip = 0;
  const call = async (path, { method = 'POST', headers = {}, json, form: formBody } = {}) => {
    ip += 1;
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        'X-Forwarded-For': `10.8.${(ip >> 8) & 255}.${ip & 255}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...(formBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : (formBody ? new URLSearchParams(formBody).toString() : undefined),
    });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, body };
  };

  const register = (method, redirect) => call('/api/mcp/oauth/register', {
    json: { redirect_uris: [redirect], client_name: `Test ${method}`, token_endpoint_auth_method: method },
  });
  const consent = async (clientId, redirect, headers = { Authorization: `Bearer ${memberJwt}` }) => call('/api/mcp/oauth/approve', {
    headers,
    json: {
      client_id: clientId, redirect_uri: redirect, code_challenge: CHALLENGE, code_challenge_method: 'S256',
      scope: 'read offline_access', approved: true,
    },
  });
  const codeFrom = (approved) => new URL(approved.body.redirect).searchParams.get('code');

  test('register with client_secret_basic → consent → tokens with a Basic header → revoke with a Basic header', async () => {
    const reg = await register('client_secret_basic', GEMINI_REDIRECT);
    expect(reg.status).toBe(201);
    const { client_id: clientId, client_secret: secret } = reg.body;
    expect(reg.body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(secret).toMatch(/^[a-f0-9]{64}$/);

    // Stored: the method and the hash, never the secret itself.
    const row = await OAuthClient.findOne({ clientId }).lean();
    expect(row.tokenEndpointAuthMethod).toBe('client_secret_basic');
    expect(row.clientSecretHash).toBe(sha256(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.expiresAt).toBeInstanceOf(Date); // reaped if never used

    const approved = await consent(clientId, GEMINI_REDIRECT);
    expect(approved.status).toBe(200);
    const code = codeFrom(approved);
    expect(code).toBeTruthy();

    // No client_id in the body: the header alone identifies the client.
    const tok = await call('/api/mcp/oauth/token', {
      headers: { Authorization: basicAuth(clientId, secret) },
      form: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: GEMINI_REDIRECT },
    });
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toMatch(/^cel_/);
    expect(tok.body.refresh_token).toBeTruthy();
    const conn = await ApiToken.findOne({ tokenHash: sha256(tok.body.access_token) }).lean();
    expect(conn).toMatchObject({ origin: 'oauth', oauthClientId: clientId, revokedAt: null });

    // Refresh with the header too: the connection rotates.
    const refreshed = await call('/api/mcp/oauth/token', {
      headers: { Authorization: basicAuth(clientId, secret) },
      form: { grant_type: 'refresh_token', refresh_token: tok.body.refresh_token },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(tok.body.refresh_token);

    const revoked = await call('/api/mcp/oauth/revoke', {
      headers: { Authorization: basicAuth(clientId, secret) },
      form: { token: refreshed.body.refresh_token },
    });
    expect(revoked.status).toBe(200);
    expect((await ApiToken.findById(conn._id).lean()).revokedAt).toBeInstanceOf(Date);
  });

  test('a wrong secret in the header is refused by the route itself, on /token and on /revoke', async () => {
    const reg = await register('client_secret_basic', GEMINI_REDIRECT);
    const clientId = reg.body.client_id;
    const approved = await consent(clientId, GEMINI_REDIRECT);
    const code = codeFrom(approved);

    for (const [path, formBody] of [
      ['/api/mcp/oauth/token', { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: GEMINI_REDIRECT }],
      ['/api/mcp/oauth/revoke', { token: 'cel_whatever' }],
    ]) {
      const r = await call(path, { headers: { Authorization: basicAuth(clientId, 'not-the-secret') }, form: formBody });
      expect(r.status).toBe(401);
      // The route's RFC 6749 §5.2 answer, not requireAuth's { error: 'No token provided' }.
      expect(r.body).toEqual({ error: 'invalid_client', error_description: 'client authentication failed' });
      expect(r.headers.get('www-authenticate')).toBe('Basic realm="Cellarion"');
    }

    // The refused exchange did not spend the code: the right secret still redeems it.
    const ok = await call('/api/mcp/oauth/token', {
      headers: { Authorization: basicAuth(clientId, reg.body.client_secret) },
      form: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: GEMINI_REDIRECT },
    });
    expect(ok.status).toBe(200);
  });

  test('consent still needs a signed-in member: a Basic header on /approve is no session', async () => {
    const reg = await register('client_secret_basic', GEMINI_REDIRECT);
    const r = await consent(reg.body.client_id, GEMINI_REDIRECT, { Authorization: basicAuth(reg.body.client_id, reg.body.client_secret) });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'No token provided' });
  });

  test('a public client needs only the body client_id, no header', async () => {
    const reg = await register('none', PUBLIC_REDIRECT);
    expect(reg.status).toBe(201);
    expect(reg.body.client_secret).toBeUndefined();
    const approved = await consent(reg.body.client_id, PUBLIC_REDIRECT);
    const tok = await call('/api/mcp/oauth/token', {
      form: { grant_type: 'authorization_code', client_id: reg.body.client_id, code: codeFrom(approved), code_verifier: VERIFIER, redirect_uri: PUBLIC_REDIRECT },
    });
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toMatch(/^cel_/);
    expect(tok.headers.get('www-authenticate')).toBeNull();
  });

  test('PKCE is still required for a Basic client on the real app', async () => {
    const reg = await register('client_secret_basic', GEMINI_REDIRECT);
    const approved = await consent(reg.body.client_id, GEMINI_REDIRECT);
    const r = await call('/api/mcp/oauth/token', {
      headers: { Authorization: basicAuth(reg.body.client_id, reg.body.client_secret) },
      form: { grant_type: 'authorization_code', code: codeFrom(approved), redirect_uri: GEMINI_REDIRECT },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_request');
  });
});
