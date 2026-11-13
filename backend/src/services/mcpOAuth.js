// OAuth 2.1 authorization-server helpers for the MCP connector flow (plan §2.4
// Phase B). Pure-ish logic — PKCE, scope handling, metadata documents, and
// token minting — kept out of the route so it is unit-testable and the route
// stays a thin HTTP shell.
//
// Standards: OAuth 2.1 + RFC 8414 (AS metadata) + RFC 9728 (protected-resource
// metadata) + RFC 7591 (DCR) + RFC 7636 (PKCE) + RFC 8707 (resource indicator).
const crypto = require('crypto');
const ApiToken = require('../models/ApiToken');

// Access tokens are short-lived; the client refreshes silently. The refresh
// token rotates on every use and the ApiToken row lives until revoked, so the
// connection persists across access-token expiries.
const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour

// The cel_ scopes an OAuth token may carry. offline_access is a meta-scope that
// only signals "issue a refresh token" (we always do) — it is advertised for
// client compatibility (claude.ai appends it) but never stored as a cel_ scope.
const { MCP_PERSONAL_SCOPES: GRANTABLE_SCOPES } = require('../config/constants');
const SUPPORTED_SCOPES = [...GRANTABLE_SCOPES, 'offline_access'];

/** Origin the AS + RS are served from (prod: https://cellarion.app). */
function issuer() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Canonical RFC 8707 resource identifier for the MCP endpoint (the audience). */
function resourceUrl() {
  return `${issuer()}/api/mcp`;
}

const OAUTH_BASE = () => `${issuer()}/api/mcp/oauth`;

// The client authentication methods /token and /revoke implement
// (authenticateClient in routes/mcpOAuth.js): 'none' for a public client, and
// a client secret in the request body or in an HTTP Basic header for a
// confidential one (RFC 6749 §2.3.1). /register accepts exactly these, and the
// AS metadata advertises exactly these.
const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

/**
 * RFC 8414 Authorization Server Metadata — served at
 * /.well-known/oauth-authorization-server. Only S256 PKCE, only the code +
 * refresh grants, public (none) and the two client-secret methods.
 */
function authServerMetadata() {
  const base = OAUTH_BASE();
  return {
    issuer: issuer(),
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    // Stated, not left out: RFC 8414 §2 reads an absent list as
    // client_secret_basic only, and a public client revokes with 'none'.
    revocation_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
    code_challenge_methods_supported: ['S256'],
    service_documentation: 'https://github.com/jagduvi1/Cellarion',
  };
}

/**
 * RFC 9728 Protected Resource Metadata — served at
 * /.well-known/oauth-protected-resource/api/mcp. `resource` MUST equal the URL
 * the user typed into their client, and authorization_servers[0] is the AS.
 */
function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: SUPPORTED_SCOPES,
    resource_name: 'Cellarion MCP',
    resource_documentation: 'https://github.com/jagduvi1/Cellarion',
    bearer_methods_supported: ['header'],
  };
}

/** base64url(SHA-256(input)) — the S256 PKCE transform (RFC 7636 §4.2). */
function s256(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

/**
 * Verify a PKCE code_verifier against the stored S256 challenge in constant
 * time. The verifier must be 43–128 unreserved chars (RFC 7636 §4.1).
 */
function verifyPkce(codeVerifier, storedChallenge) {
  if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  if (typeof storedChallenge !== 'string' || !storedChallenge) return false;
  const computed = s256(codeVerifier);
  const a = Buffer.from(computed);
  const b = Buffer.from(storedChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Parse+validate an OAuth `scope` string into the cel_ scopes we will actually
 * grant. Unknown scopes are dropped (not an error — RFC 6749 §3.3 allows the AS
 * to narrow). offline_access is accepted but not a cel_ scope. Returns the
 * granted cel_ scope array (deduped, at least 'read' if nothing valid was asked
 * — an MCP connection with zero scope is useless, and read is the floor).
 */
function grantedScopes(scopeStr) {
  const requested = String(scopeStr || '').split(/\s+/).filter(Boolean);
  const granted = GRANTABLE_SCOPES.filter((s) => requested.includes(s));
  return granted.length ? [...new Set(granted)] : ['read'];
}

// The longest Authorization header read as client credentials. A client id
// and secret this server issues are 160 characters in base64; the bound keeps
// a hostile header from being decoded at all.
const MAX_BASIC_AUTH_HEADER_LEN = 1024;
const MALFORMED_BASIC = Object.freeze({ malformed: true });

/** One credential part, application/x-www-form-urlencoded decoded (RFC 6749 §2.3.1, Appendix B); null when the encoding is broken. */
function formDecode(part) {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * Read client credentials from an `Authorization: Basic` header (RFC 6749
 * §2.3.1, RFC 7617). Called by authenticateClient in routes/mcpOAuth.js for
 * /token and /revoke; there is no MCP twin. Returns null when there is no
 * Basic header (absent, or another scheme), { malformed: true } when it
 * cannot be read (too long, not base64, no colon, broken encoding, empty id),
 * else { clientId, clientSecret }, where the secret may be '' (a public client).
 */
function parseClientBasicAuth(header) {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  const gap = value.search(/[ \t]/);
  const scheme = gap === -1 ? value : value.slice(0, gap);
  // The scheme name is case-insensitive (RFC 7235 §2.1).
  if (scheme.toLowerCase() !== 'basic') return null;
  if (header.length > MAX_BASIC_AUTH_HEADER_LEN) return MALFORMED_BASIC;

  const encoded = gap === -1 ? '' : value.slice(gap).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return MALFORMED_BASIC;
  const bytes = Buffer.from(encoded, 'base64');
  // Node's decoder skips what it cannot read; a value that does not encode
  // back to itself was not base64.
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return MALFORMED_BASIC;

  // Split on the FIRST colon: the id is encoded, so a colon in it is %3A,
  // while a secret may carry one as it is.
  const decoded = bytes.toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return MALFORMED_BASIC;
  const clientId = formDecode(decoded.slice(0, colon));
  const clientSecret = formDecode(decoded.slice(colon + 1));
  if (!clientId || clientSecret === null) return MALFORMED_BASIC;
  return { clientId, clientSecret };
}

/**
 * Whether a redirect_uri exactly matches one registered for the client. Exact
 * string match (OAuth 2.1 §4.1.3 / security BCP) — no prefix/substring, no
 * normalization games. Loopback port-flexibility is intentionally NOT granted
 * here: DCR clients register their exact callback, including native loopback
 * ports, and match it verbatim.
 */
function redirectUriRegistered(client, redirectUri) {
  return Array.isArray(client?.redirectUris) && client.redirectUris.includes(redirectUri);
}

/**
 * Mint a fresh access+refresh token pair onto an ApiToken row and return the
 * raw values + expiry. The row is the durable OAuth CONNECTION; this rotates
 * its credentials (used both at first code-exchange and on every refresh).
 * Returns { access_token, refresh_token, expiresAt }.
 */
function rotateCredentials() {
  const access = ApiToken.generateToken();          // cel_… (the Bearer)
  const refresh = ApiToken.generateRefreshToken();  // opaque, refresh-grant only
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
  return {
    raw: { access, refresh },
    fields: {
      tokenHash: ApiToken.hashToken(access),
      refreshTokenHash: ApiToken.hashToken(refresh),
      expiresAt,
    },
    expiresAt,
  };
}

/** The OAuth token-endpoint response body (RFC 6749 §5.1). */
function tokenResponse(rawAccess, rawRefresh, scopes) {
  return {
    access_token: rawAccess,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: rawRefresh,
    scope: scopes.join(' '),
  };
}

/**
 * Revoke every OAuth-connection token a user holds — the AI-assistant
 * connections minted through the consent flow (`oauthClientId` set), NOT the
 * user's own personal API tokens (HA integration, climate devices), which
 * carry a null `oauthClientId` and keep their deliberate PAT semantics
 * (survive password change — decided on the HA-tokens PR).
 *
 * Called when a user changes or resets their password (security report
 * 2026-08-27, second analysis): a phished OAuth connection is a third-party
 * grant, and the natural "secure my account" reflex must end it — the same
 * trust boundary already applied to login sessions and SSE streams two lines
 * away in the auth handlers. Soft revoke (`revokedAt`) so the connection
 * still shows as revoked in the Settings list; the MCP auth middleware
 * filters `revokedAt: null`, so access dies on the next request.
 *
 * Returns the number of connections revoked (0 when the user had none).
 */
async function revokeOAuthConnectionsForUser(userId) {
  const res = await ApiToken.updateMany(
    { user: userId, oauthClientId: { $ne: null }, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return res.modifiedCount || 0;
}

module.exports = {
  ACCESS_TOKEN_TTL_SEC,
  CLIENT_AUTH_METHODS,
  MAX_BASIC_AUTH_HEADER_LEN,
  issuer,
  resourceUrl,
  authServerMetadata,
  protectedResourceMetadata,
  s256,
  verifyPkce,
  grantedScopes,
  parseClientBasicAuth,
  redirectUriRegistered,
  rotateCredentials,
  tokenResponse,
  revokeOAuthConnectionsForUser,
};
