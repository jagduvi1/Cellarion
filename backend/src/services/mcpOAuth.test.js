/**
 * OAuth AS helpers — the security-critical primitives run for REAL (no mocks):
 * the S256 PKCE transform + constant-time verify, scope narrowing, exact
 * redirect-URI matching, and the shape of the discovery documents. A bug in any
 * of these is an auth bypass, so they are pinned against RFC test vectors.
 */
const crypto = require('crypto');
const oauth = require('./mcpOAuth');

beforeAll(() => { process.env.FRONTEND_URL = 'https://cellarion.app'; });

describe('PKCE (RFC 7636)', () => {
  // The canonical RFC 7636 Appendix B test vector.
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  test('s256 matches the RFC vector', () => {
    expect(oauth.s256(VERIFIER)).toBe(CHALLENGE);
  });

  test('verifyPkce accepts the matching verifier, rejects everything else', () => {
    expect(oauth.verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
    expect(oauth.verifyPkce(VERIFIER + 'x', CHALLENGE)).toBe(false); // wrong verifier
    expect(oauth.verifyPkce(VERIFIER, CHALLENGE.slice(0, -1) + 'X')).toBe(false); // wrong challenge
    expect(oauth.verifyPkce('short', CHALLENGE)).toBe(false); // < 43 chars → rejected
    expect(oauth.verifyPkce('a'.repeat(200), CHALLENGE)).toBe(false); // > 128 chars
    expect(oauth.verifyPkce('bad chars!! not unreserved padding padding padding', CHALLENGE)).toBe(false);
    expect(oauth.verifyPkce(null, CHALLENGE)).toBe(false);
    expect(oauth.verifyPkce(VERIFIER, '')).toBe(false);
    expect(oauth.verifyPkce(VERIFIER, null)).toBe(false);
  });

  test('a freshly generated verifier round-trips', () => {
    const verifier = crypto.randomBytes(32).toString('base64url'); // 43 chars, unreserved
    expect(oauth.verifyPkce(verifier, oauth.s256(verifier))).toBe(true);
  });
});

describe('grantedScopes — narrow only, read floor', () => {
  test('keeps only cel_ scopes, drops unknown + offline_access', () => {
    expect(oauth.grantedScopes('read write')).toEqual(['read', 'write']);
    expect(oauth.grantedScopes('read consume write')).toEqual(['read', 'consume', 'write']);
    expect(oauth.grantedScopes('read offline_access')).toEqual(['read']); // offline_access is not a cel_ scope
    expect(oauth.grantedScopes('bogus admin')).toEqual(['read']); // unknown → floor to read
    expect(oauth.grantedScopes('')).toEqual(['read']);
    expect(oauth.grantedScopes(undefined)).toEqual(['read']);
    expect(oauth.grantedScopes('write write')).toEqual(['write']); // deduped
  });
});

describe('redirectUriRegistered — exact match only', () => {
  const client = { redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:1410/callback'] };
  test('exact match passes; anything else fails', () => {
    expect(oauth.redirectUriRegistered(client, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(oauth.redirectUriRegistered(client, 'https://claude.ai/api/mcp/auth_callback/')).toBe(false); // trailing slash
    expect(oauth.redirectUriRegistered(client, 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false);
    expect(oauth.redirectUriRegistered(client, 'https://evil.example/cb')).toBe(false);
    expect(oauth.redirectUriRegistered({ redirectUris: [] }, 'https://claude.ai/api/mcp/auth_callback')).toBe(false);
    expect(oauth.redirectUriRegistered(null, 'x')).toBe(false);
  });
});

describe('discovery documents', () => {
  test('AS metadata advertises exactly the supported grants + S256 PKCE', () => {
    const m = oauth.authServerMetadata();
    expect(m.issuer).toBe('https://cellarion.app');
    expect(m.authorization_endpoint).toBe('https://cellarion.app/api/mcp/oauth/authorize');
    expect(m.token_endpoint).toBe('https://cellarion.app/api/mcp/oauth/token');
    expect(m.registration_endpoint).toBe('https://cellarion.app/api/mcp/oauth/register');
    expect(m.response_types_supported).toEqual(['code']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.code_challenge_methods_supported).toEqual(['S256']); // never 'plain'
    expect(m.token_endpoint_auth_methods_supported).toContain('none'); // public clients
  });

  test('PRM resource is the MCP URL and points at the AS', () => {
    const m = oauth.protectedResourceMetadata();
    expect(m.resource).toBe('https://cellarion.app/api/mcp');
    expect(m.authorization_servers).toEqual(['https://cellarion.app']);
    expect(m.bearer_methods_supported).toEqual(['header']);
  });
});

describe('rotateCredentials + tokenResponse', () => {
  test('mints a cel_ access token, stores only hashes, ~1h expiry', () => {
    const before = Date.now();
    const cred = oauth.rotateCredentials();
    expect(cred.raw.access).toMatch(/^cel_[a-f0-9]{64}$/);
    expect(cred.raw.refresh).toMatch(/^[a-f0-9]{64}$/); // opaque, no cel_ prefix
    // The stored fields are HASHES, never the raw tokens.
    expect(cred.fields.tokenHash).toBe(crypto.createHash('sha256').update(cred.raw.access).digest('hex'));
    expect(cred.fields.refreshTokenHash).toBe(crypto.createHash('sha256').update(cred.raw.refresh).digest('hex'));
    expect(cred.fields.tokenHash).not.toContain(cred.raw.access);
    const ttl = cred.fields.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  test('tokenResponse is the RFC 6749 §5.1 shape', () => {
    const r = oauth.tokenResponse('cel_abc', 'refresh123', ['read', 'write']);
    expect(r).toEqual({
      access_token: 'cel_abc',
      token_type: 'bearer',
      expires_in: oauth.ACCESS_TOKEN_TTL_SEC,
      refresh_token: 'refresh123',
      scope: 'read write',
    });
  });
});
