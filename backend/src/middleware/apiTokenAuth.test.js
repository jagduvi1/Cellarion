/**
 * Personal API token auth (docs/ha-push-events.md §3).
 *
 * WHY THIS TEST EXISTS:
 * API tokens are scoped, DEFAULT-DENY credentials. The single most important
 * property is that a token is rejected on every route NOT explicitly
 * allowlisted for its scopes — a leaked "read-only" Home Assistant token must
 * not be able to export the account, delete it, or mint more tokens. These
 * tests pin the allowlist semantics and the auth path (revocation, pending
 * deletion, plan downgrade, lastUsedAt throttling).
 */

jest.mock('../models/ApiToken', () => {
  const crypto = require('crypto');
  const mock = {
    findOne: jest.fn(),
    updateOne: jest.fn(() => ({ catch: () => {} })),
    hashToken: (raw) => crypto.createHash('sha256').update(raw).digest('hex'),
    TOKEN_PREFIX: 'cel_',
  };
  return mock;
});
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const { logAudit } = require('../services/audit');
const {
  isApiTokenCredential,
  authenticateApiToken,
  isRequestAllowed,
} = require('./apiTokenAuth');

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Credential detection
// ---------------------------------------------------------------------------
describe('isApiTokenCredential', () => {
  test('cel_-prefixed strings are API tokens', () => {
    expect(isApiTokenCredential('cel_' + 'a'.repeat(64))).toBe(true);
  });
  test('JWTs and garbage are not', () => {
    expect(isApiTokenCredential('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(isApiTokenCredential('')).toBe(false);
    expect(isApiTokenCredential(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default-deny allowlist
// ---------------------------------------------------------------------------
describe('isRequestAllowed (default-deny)', () => {
  const READ = ['read'];
  const CONSUME = ['consume'];
  const BOTH = ['read', 'consume'];
  const oid = 'a'.repeat(24);

  test.each([
    ['GET', '/api/stats/overview'],
    ['GET', '/api/stats'],
    ['GET', '/api/cellars'],
    ['GET', `/api/cellars/${oid}`],
    ['GET', '/api/bottles'],
    ['GET', `/api/bottles/${oid}`],
    ['GET', '/api/notifications'],
    ['GET', '/api/events/stream'],
    ['GET', '/api/auth/whoami'],
    ['POST', '/api/mcp'],
  ])('read scope allows %s %s', (method, path) => {
    expect(isRequestAllowed(READ, method, path)).toBe(true);
  });

  test('HEAD is treated as GET, trailing slash is normalized', () => {
    expect(isRequestAllowed(READ, 'HEAD', '/api/stats/overview')).toBe(true);
    expect(isRequestAllowed(READ, 'GET', '/api/cellars/')).toBe(true);
  });

  test.each([
    // Sensitive reads a "read" token must NOT reach
    ['GET', '/api/users/me/export'],
    ['GET', '/api/tokens'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/auth/me'], // /whoami is allowed but /me (full user + PII) is NOT
    // A prefix that merely CONTAINS an allowed prefix
    ['GET', '/api/statsy'],
    ['GET', '/api/cellars-export'],
    // whoami is exact-anchored: no other method, sibling, or sub-path leaks
    ['POST', '/api/auth/whoami'],
    ['GET', '/api/auth/whoami/extra'],
    ['GET', '/api/auth/whoamix'],
    ['GET', '/api/auth/logout'],
    // MCP is exact-anchored: no sibling, no sub-path leaks (GET/DELETE on the
    // exact path are allowed since Phase 4 sessions — pinned separately below)
    ['POST', '/api/mcp/extra'],
    ['POST', '/api/mcpx'],
    ['GET', '/api/mcp/activity'],
    // Writes are never granted by read
    ['POST', '/api/bottles'],
    ['DELETE', `/api/cellars/${oid}`],
    ['POST', `/api/bottles/${oid}/consume`],
    ['POST', '/api/tokens'],
    ['DELETE', '/api/users/me'],
  ])('read scope denies %s %s', (method, path) => {
    expect(isRequestAllowed(READ, method, path)).toBe(false);
  });

  test('consume scope allows exactly POST /api/bottles/:id/consume', () => {
    expect(isRequestAllowed(CONSUME, 'POST', `/api/bottles/${oid}/consume`)).toBe(true);
    expect(isRequestAllowed(CONSUME, 'POST', '/api/bottles/notanid/consume')).toBe(false);
    expect(isRequestAllowed(CONSUME, 'POST', `/api/bottles/${oid}/consume/extra`)).toBe(false);
    expect(isRequestAllowed(CONSUME, 'GET', '/api/stats/overview')).toBe(false);
    expect(isRequestAllowed(CONSUME, 'DELETE', `/api/bottles/${oid}`)).toBe(false);
  });

  test.each([
    // PII-bearing / non-wine-data endpoints under the allowed prefixes must be
    // excluded even for a read token (audit log carries collaborator IPs and
    // emails; members carries emails; import is a separate subsystem).
    ['GET', `/api/cellars/${oid}/audit`],
    ['GET', `/api/cellars/${oid}/audit/`],
    ['GET', `/api/cellars/${oid}/members`],
    ['GET', '/api/bottles/import/sessions'],
    ['GET', `/api/bottles/import/sessions/${oid}`],
  ])('read scope denies excluded sub-path %s %s', (method, path) => {
    expect(isRequestAllowed(READ, method, path)).toBe(false);
    expect(isRequestAllowed(BOTH, method, path)).toBe(false);
  });

  test('scopes combine, unknown scopes grant nothing', () => {
    expect(isRequestAllowed(BOTH, 'GET', '/api/stats/overview')).toBe(true);
    expect(isRequestAllowed(BOTH, 'POST', `/api/bottles/${oid}/consume`)).toBe(true);
    expect(isRequestAllowed(['admin'], 'GET', '/api/admin/users')).toBe(false);
    expect(isRequestAllowed([], 'GET', '/api/stats')).toBe(false);
    expect(isRequestAllowed(undefined, 'GET', '/api/stats')).toBe(false);
  });

  test('MCP session verbs: GET/DELETE on the exact path are allowed per scope', () => {
    for (const scopes of [READ, CONSUME, ['write']]) {
      expect(isRequestAllowed(scopes, 'GET', '/api/mcp')).toBe(true);
      expect(isRequestAllowed(scopes, 'DELETE', '/api/mcp')).toBe(true);
    }
    // …but never a sibling or sub-path (activity stays JWT-only).
    expect(isRequestAllowed(READ, 'GET', '/api/mcp/activity')).toBe(false);
    expect(isRequestAllowed(READ, 'DELETE', '/api/mcp/public')).toBe(false);
  });

  test('isMcpEndpoint (OAuth audience): all three session verbs on the exact path, nothing else', () => {
    const { isMcpEndpoint } = require('./apiTokenAuth');
    // The MCP session lifecycle: POST requests, GET SSE stream, DELETE terminate.
    // Confining OAuth tokens to POST alone would let a connector initialize a
    // session it could never stream from or terminate (#719 + #723 coordination).
    for (const method of ['POST', 'GET', 'DELETE']) {
      expect(isMcpEndpoint(method, '/api/mcp')).toBe(true);
      expect(isMcpEndpoint(method, '/api/mcp/')).toBe(true); // trailing slash normalized
    }
    expect(isMcpEndpoint('PUT', '/api/mcp')).toBe(false);
    expect(isMcpEndpoint('GET', '/api/mcp/activity')).toBe(false);
    expect(isMcpEndpoint('POST', '/api/mcp/public')).toBe(false);
    expect(isMcpEndpoint('GET', '/api/stats')).toBe(false);
  });

  test('climate scope allows exactly POST /api/climate/ingest — the device credential', () => {
    const CLIMATE = ['climate'];
    expect(isRequestAllowed(CLIMATE, 'POST', '/api/climate/ingest')).toBe(true);
    expect(isRequestAllowed(CLIMATE, 'POST', '/api/climate/ingest/')).toBe(true);
    // A leaked device token must reach NOTHING else — not device management,
    // not cellar reads, not the wine data the read scope covers.
    expect(isRequestAllowed(CLIMATE, 'GET', '/api/climate/devices')).toBe(false);
    expect(isRequestAllowed(CLIMATE, 'POST', '/api/climate/devices')).toBe(false);
    expect(isRequestAllowed(CLIMATE, 'DELETE', `/api/climate/devices/${oid}`)).toBe(false);
    expect(isRequestAllowed(CLIMATE, 'GET', `/api/climate/cellars/${oid}/current`)).toBe(false);
    expect(isRequestAllowed(CLIMATE, 'PUT', `/api/climate/cellars/${oid}/config`)).toBe(false);
    expect(isRequestAllowed(CLIMATE, 'GET', '/api/stats/overview')).toBe(false);
    expect(isRequestAllowed(CLIMATE, 'GET', '/api/cellars')).toBe(false);
    expect(isRequestAllowed(CLIMATE, 'GET', '/api/users/me/export')).toBe(false);
    // And the other scopes never grant ingest.
    expect(isRequestAllowed(READ, 'POST', '/api/climate/ingest')).toBe(false);
    expect(isRequestAllowed(BOTH, 'POST', '/api/climate/ingest')).toBe(false);
  });

  test('POST /api/mcp is granted by read AND consume — per-tool authz lives inside the MCP registry', () => {
    expect(isRequestAllowed(READ, 'POST', '/api/mcp')).toBe(true);
    expect(isRequestAllowed(BOTH, 'POST', '/api/mcp')).toBe(true); // read+consume
    // consume tokens reach the endpoint since the consume tools shipped; the
    // registry scope filter decides which tools they actually see.
    expect(isRequestAllowed(CONSUME, 'POST', '/api/mcp')).toBe(true);
    // climate (device credential) still reaches NOTHING but ingest.
    expect(isRequestAllowed(['climate'], 'POST', '/api/mcp')).toBe(false);
    // GET/DELETE are granted since stateful sessions (Phase 4): GET opens the
    // session's SSE stream, DELETE terminates it — both no-ops without a live
    // session bound to this exact token. Sub-paths stay exact-anchored-denied.
    expect(isRequestAllowed(READ, 'GET', '/api/mcp')).toBe(true);
    expect(isRequestAllowed(CONSUME, 'GET', '/api/mcp')).toBe(true);
    expect(isRequestAllowed(READ, 'DELETE', '/api/mcp')).toBe(true);
    expect(isRequestAllowed(['climate'], 'GET', '/api/mcp')).toBe(false);
    expect(isRequestAllowed(READ, 'POST', '/api/mcp/tools')).toBe(false);
    expect(isRequestAllowed(READ, 'GET', '/api/mcp/activity')).toBe(false); // timeline stays JWT-only
  });

  test('write scope: MCP endpoint only — never any REST route', () => {
    const WRITE = ['write'];
    expect(isRequestAllowed(WRITE, 'POST', '/api/mcp')).toBe(true);
    expect(isRequestAllowed(WRITE, 'GET', '/api/mcp')).toBe(true);   // session SSE stream
    expect(isRequestAllowed(WRITE, 'DELETE', '/api/mcp')).toBe(true); // session termination
    expect(isRequestAllowed(WRITE, 'POST', '/api/bottles')).toBe(false);
    expect(isRequestAllowed(WRITE, 'PUT', '/api/bottles/' + 'a'.repeat(24))).toBe(false);
    expect(isRequestAllowed(WRITE, 'GET', '/api/cellars')).toBe(false);
    expect(isRequestAllowed(WRITE, 'GET', '/api/mcp/activity')).toBe(false);
  });

  test('GET /api/auth/whoami is granted ONLY by read (own account id for HA reauth)', () => {
    expect(isRequestAllowed(READ, 'GET', '/api/auth/whoami')).toBe(true);
    expect(isRequestAllowed(BOTH, 'GET', '/api/auth/whoami')).toBe(true); // read+consume
    expect(isRequestAllowed(CONSUME, 'GET', '/api/auth/whoami')).toBe(false);
    expect(isRequestAllowed(['climate'], 'GET', '/api/auth/whoami')).toBe(false);
    // Never the wider /me even for read.
    expect(isRequestAllowed(READ, 'GET', '/api/auth/me')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// authenticateApiToken
// ---------------------------------------------------------------------------
describe('authenticateApiToken', () => {
  const RAW = 'cel_' + 'f'.repeat(64);
  const userId = { toString: () => 'u1' };
  const tokenId = { toString: () => 't1' };

  const mockReq = (method = 'GET', baseUrl = '/api/stats', path = '/overview') =>
    ({ method, baseUrl, path, headers: {} });
  const mockRes = () => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    return res;
  };
  const activeToken = (over = {}) => ({
    _id: tokenId, user: 'u1', scopes: ['read'], lastUsedAt: null, ...over,
  });
  const activeUser = (over = {}) => ({
    _id: userId, roles: ['user'], plan: 'free', planExpiresAt: null, deletionScheduledFor: null, ...over,
  });
  const selectable = (doc) => ({ select: jest.fn().mockResolvedValue(doc) });

  test('valid token on an allowed route attaches req.user + req.apiToken', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken());
    User.findById.mockReturnValue(selectable(activeUser()));
    const req = mockReq(); const res = mockRes(); const next = jest.fn();

    await authenticateApiToken(req, res, next, RAW);

    expect(ApiToken.findOne).toHaveBeenCalledWith({ tokenHash: ApiToken.hashToken(RAW), revokedAt: null });
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id: 'u1', roles: ['user'], plan: 'free', planExpiresAt: null });
    expect(req.apiToken).toEqual({ id: 't1', scopes: ['read'] });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('unknown or revoked token → 401 (findOne filters revokedAt null)', async () => {
    ApiToken.findOne.mockResolvedValue(null);
    const req = mockReq(); const res = mockRes(); const next = jest.fn();

    await authenticateApiToken(req, res, next, RAW);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('token whose user is gone → 401', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken());
    User.findById.mockReturnValue(selectable(null));
    const res = mockRes(); const next = jest.fn();

    await authenticateApiToken(mockReq(), res, next, RAW);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('token whose user has a pending deletion → 401', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken());
    User.findById.mockReturnValue(selectable(activeUser({ deletionScheduledFor: new Date() })));
    const res = mockRes(); const next = jest.fn();

    await authenticateApiToken(mockReq(), res, next, RAW);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // ── OAuth connections (origin:'oauth') ────────────────────────────────────
  // An OAuth access token is a cel_ token PLUS an expiry and a single audience.
  test('an EXPIRED OAuth access token → 401 (drives the client to refresh)', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken({ origin: 'oauth', expiresAt: new Date(Date.now() - 1000) }));
    User.findById.mockReturnValue(selectable(activeUser()));
    const res = mockRes(); const next = jest.fn();

    await authenticateApiToken(mockReq('POST', '/api/mcp', '/'), res, next, RAW);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('a personal PAT (expiresAt null) never expires', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken({ expiresAt: null }));
    User.findById.mockReturnValue(selectable(activeUser()));
    const next = jest.fn();
    await authenticateApiToken(mockReq(), mockRes(), next, RAW);
    expect(next).toHaveBeenCalled();
  });

  test('an OAuth token is confined to POST /api/mcp — its RFC 8707 audience', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken({ origin: 'oauth', expiresAt: new Date(Date.now() + 60000) }));
    User.findById.mockReturnValue(selectable(activeUser()));
    const next = jest.fn();
    await authenticateApiToken(mockReq('POST', '/api/mcp', '/'), mockRes(), next, RAW);
    expect(next).toHaveBeenCalled(); // its own audience: allowed
  });

  test('an OAuth token CANNOT use the REST routes its read scope would otherwise grant', async () => {
    // The consent screen promised the MCP endpoint — not the whole read surface.
    for (const [method, baseUrl, path] of [
      ['GET', '/api/stats', '/overview'],
      ['GET', '/api/cellars', '/'],
      ['GET', '/api/bottles', '/'],
      ['GET', '/api/auth', '/whoami'],
    ]) {
      ApiToken.findOne.mockResolvedValue(activeToken({ origin: 'oauth', expiresAt: new Date(Date.now() + 60000) }));
      User.findById.mockReturnValue(selectable(activeUser()));
      const res = mockRes(); const next = jest.fn();
      await authenticateApiToken(mockReq(method, baseUrl, path), res, next, RAW);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  test('a personal read PAT still reaches those same REST routes (unaffected)', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken()); // origin defaults to personal
    User.findById.mockReturnValue(selectable(activeUser()));
    const next = jest.fn();
    await authenticateApiToken(mockReq('GET', '/api/stats', '/overview'), mockRes(), next, RAW);
    expect(next).toHaveBeenCalled();
  });

  test('valid token on a NON-allowlisted route → 403, req.user never attached', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken());
    User.findById.mockReturnValue(selectable(activeUser()));
    const req = mockReq('GET', '/api/users', '/me/export');
    const res = mockRes(); const next = jest.fn();

    await authenticateApiToken(req, res, next, RAW);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  test('expired plan is downgraded to free (same as the JWT path)', async () => {
    ApiToken.findOne.mockResolvedValue(activeToken());
    User.findById.mockReturnValue(selectable(activeUser({
      plan: 'patron', planExpiresAt: new Date(Date.now() - 1000),
    })));
    const req = mockReq(); const res = mockRes(); const next = jest.fn();

    await authenticateApiToken(req, res, next, RAW);

    expect(next).toHaveBeenCalled();
    expect(req.user.plan).toBe('free');
  });

  test('lastUsedAt is written (and token.used audited) only when stale', async () => {
    // Fresh lastUsedAt → no write, no audit
    ApiToken.findOne.mockResolvedValue(activeToken({ lastUsedAt: new Date() }));
    User.findById.mockReturnValue(selectable(activeUser()));
    await authenticateApiToken(mockReq(), mockRes(), jest.fn(), RAW);
    expect(ApiToken.updateOne).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();

    // Stale lastUsedAt → one write + one audit with the token id, never the token
    ApiToken.findOne.mockResolvedValue(activeToken({ lastUsedAt: new Date(Date.now() - 2 * 3600 * 1000) }));
    await authenticateApiToken(mockReq(), mockRes(), jest.fn(), RAW);
    expect(ApiToken.updateOne).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'token.used', { type: 'apiToken', id: tokenId }, {});
    const auditJson = JSON.stringify(logAudit.mock.calls);
    expect(auditJson).not.toContain(RAW);
  });
});
