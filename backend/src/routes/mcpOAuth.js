const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const ApiToken = require('../models/ApiToken');
const OAuthClient = require('../models/OAuthClient');
const OAuthAuthCode = require('../models/OAuthAuthCode');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { rateLimitKey } = require('../utils/clientIp');
const { logAudit } = require('../services/audit');

// Dedicated strict limiter for unauthenticated Dynamic Client Registration
// (security audit M-6): /register persists an OAuthClient row per call and
// otherwise rode only the 200/15min global write limiter — an IP-rotating
// attacker could accumulate ~19k inert client rows/day. Real MCP clients
// register once. 10/hour/IP is generous for that and shuts the flood.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'invalid_request', error_description: 'Too many client registrations from this address; try again later.' },
});
const eventBus = require('../services/eventBus');
const {
  issuer, resourceUrl, verifyPkce, grantedScopes, redirectUriRegistered,
  rotateCredentials, tokenResponse,
} = require('../services/mcpOAuth');

// The OAuth 2.1 authorization server for the MCP connector (plan §2.4 Phase B).
// Mounted at /api/mcp/oauth. Endpoints:
//   POST /register   RFC 7591 Dynamic Client Registration (public, rate-limited)
//   GET  /authorize  validate the request, then bounce the browser to the
//                    frontend consent page (the interactive step)
//   POST /approve    the logged-in user's consent → mints a single-use code
//   POST /token      code→token exchange + refresh-token rotation
//   POST /revoke     RFC 7009 token revocation
//
// The issued access token is a scoped, EXPIRING cel_ ApiToken (origin:'oauth'),
// so /api/mcp auth, the SCOPE_ALLOWLIST, instant revoke and the connected-tokens
// UI all work unchanged (middleware/apiTokenAuth.js).

// /token and /revoke are application/x-www-form-urlencoded (RFC 6749 §4.1.3 /
// RFC 7009). The global express.json() skips those content-types, so add a
// urlencoded parser here; /register (json) is already parsed globally.
router.use(express.urlencoded({ extended: false }));

const MAX_REDIRECT_URIS = 5;
const MAX_OAUTH_CONNECTIONS_PER_USER = 20; // Claude + ChatGPT + Desktop + … — generous, but bounded.

// ── error helpers (RFC 6749 §5.2) ────────────────────────────────────────────
function oauthError(res, status, error, description) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error, error_description: description });
}
// Errors that happen AFTER redirect_uri is validated go back to the client as
// query params on the redirect (RFC 6749 §4.1.2.1), preserving state.
function redirectError(res, redirectUri, error, description, state) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return res.redirect(302, u.toString());
}

function isValidRedirectUri(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === 'https:') return true;
  // Loopback for native clients (RFC 8252) — http only on localhost/127.0.0.1/::1.
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) return true;
  return false;
}

// ── POST /register — Dynamic Client Registration (RFC 7591) ──────────────────
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
      return oauthError(res, 400, 'invalid_redirect_uri', `redirect_uris must be a non-empty array of at most ${MAX_REDIRECT_URIS} URLs`);
    }
    if (!redirectUris.every(isValidRedirectUri)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must all be https, or http on a loopback host');
    }
    // Only the two methods the token endpoint actually implements, and that the
    // AS metadata advertises. `client_secret_basic` is deliberately NOT accepted
    // — authenticateClient reads the secret from the body only, so a basic
    // client could never authenticate; rejecting it at registration is honest
    // instead of handing out a client_id that can never get a token.
    const authMethod = body.token_endpoint_auth_method || 'none';
    if (!['none', 'client_secret_post'].includes(authMethod)) {
      return oauthError(res, 400, 'invalid_client_metadata', 'token_endpoint_auth_method must be "none" or "client_secret_post"');
    }

    const clientId = OAuthClient.generateClientId();
    let rawSecret = null;
    let clientSecretHash = null;
    if (authMethod !== 'none') {
      rawSecret = OAuthClient.generateClientSecret();
      clientSecretHash = OAuthClient.hashSecret(rawSecret);
    }

    const client = await OAuthClient.create({
      clientId,
      clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null,
      redirectUris,
      tokenEndpointAuthMethod: authMethod,
      clientSecretHash,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      softwareId: typeof body.software_id === 'string' ? body.software_id.slice(0, 200) : null,
      softwareVersion: typeof body.software_version === 'string' ? body.software_version.slice(0, 50) : null,
      // Auto-reap if it never completes a token exchange (M-6). Cleared on
      // first use below, so a real connector persists.
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    logAudit(req, 'oauth.client_registered', { type: 'oauthClient', id: client._id }, { clientName: client.clientName });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      client_name: client.clientName || undefined,
      ...(rawSecret ? { client_secret: rawSecret, client_secret_expires_at: 0 } : {}),
    });
  } catch (err) {
    console.error('DCR register error:', err);
    return oauthError(res, 500, 'server_error', 'registration failed');
  }
});

// ── GET /authorize — validate, then hand off to the frontend consent page ────
router.get('/authorize', async (req, res) => {
  try {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state, resource } = req.query;

    // Client + redirect_uri are validated FIRST and pre-redirect: an unknown
    // client or unregistered redirect_uri must never be redirected to (open-
    // redirect / code-leak guard) — these fail with a plain 400.
    if (!client_id || typeof client_id !== 'string') return oauthError(res, 400, 'invalid_request', 'client_id is required');
    const client = await OAuthClient.findOne({ clientId: client_id });
    if (!client) return oauthError(res, 400, 'invalid_client', 'unknown client_id');
    if (!redirect_uri || !redirectUriRegistered(client, redirect_uri)) {
      return oauthError(res, 400, 'invalid_request', 'redirect_uri does not match a registered URI');
    }

    // From here the redirect_uri is trusted, so protocol errors go back to it.
    if (response_type !== 'code') return redirectError(res, redirect_uri, 'unsupported_response_type', 'only response_type=code is supported', state);
    if (!code_challenge || code_challenge_method !== 'S256') {
      return redirectError(res, redirect_uri, 'invalid_request', 'PKCE code_challenge with method S256 is required', state);
    }
    if (resource && resource !== resourceUrl()) {
      return redirectError(res, redirect_uri, 'invalid_target', 'resource must be the MCP endpoint URL', state);
    }

    // Hand off to the frontend consent screen, carrying the (validated) request.
    // The user authenticates there (they have their session) and approves; the
    // frontend POSTs back to /approve, which re-validates everything server-side.
    const consent = new URL(`${issuer()}/connect-ai/authorize`);
    consent.searchParams.set('client_id', client_id);
    consent.searchParams.set('redirect_uri', redirect_uri);
    consent.searchParams.set('code_challenge', code_challenge);
    consent.searchParams.set('code_challenge_method', 'S256');
    consent.searchParams.set('scope', typeof scope === 'string' ? scope : '');
    if (state) consent.searchParams.set('state', state);
    if (resource) consent.searchParams.set('resource', resource);
    if (client.clientName) consent.searchParams.set('client_name', client.clientName);
    return res.redirect(302, consent.toString());
  } catch (err) {
    console.error('OAuth authorize error:', err);
    return oauthError(res, 500, 'server_error', 'authorization failed');
  }
});

// ── POST /approve — the logged-in user's consent decision ────────────────────
// JWT-only (requireAuth + requireNonDemo): the consenting party is a real
// logged-in user, never a cel_ token or a demo account. Re-validates the whole
// request against the DB — the browser round-trip through the consent page is
// UX, not trust.
router.post('/approve', requireAuth, requireNonDemo, async (req, res) => {
  try {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, scope, state, resource, approved } = req.body || {};

    // typeof guard before the query: this body is JSON, so an object value
    // (`{"$ne":null}`) would otherwise reach Mongo as an operator. Same guard as
    // /authorize and /token.
    if (typeof client_id !== 'string') return res.status(400).json({ error: 'unknown client' });
    const client = await OAuthClient.findOne({ clientId: client_id });
    if (!client) return res.status(400).json({ error: 'unknown client' });
    if (typeof redirect_uri !== 'string') return res.status(400).json({ error: 'redirect_uri does not match a registered URI' });
    if (!redirect_uri || !redirectUriRegistered(client, redirect_uri)) {
      return res.status(400).json({ error: 'redirect_uri does not match a registered URI' });
    }

    // Denied → bounce back to the client with an error (no code minted).
    if (approved !== true) {
      const u = new URL(redirect_uri);
      u.searchParams.set('error', 'access_denied');
      if (state) u.searchParams.set('state', state);
      return res.json({ redirect: u.toString() });
    }

    if (!code_challenge || code_challenge_method !== 'S256') {
      return res.status(400).json({ error: 'PKCE S256 challenge required' });
    }
    if (resource && resource !== resourceUrl()) {
      return res.status(400).json({ error: 'invalid resource' });
    }

    // The user's scope CHOICE: the consent page may NARROW the client's
    // requested scopes ("connect read-only" is a promise the launch post
    // makes, and the consent moment is where it belongs). Rules: the choice
    // must be a subset of what the client requested (offered = requested ∩
    // grantable), and 'read' is the floor — every flow starts with lookups,
    // so a read-less grant would just be a broken connector. `scopes` absent
    // (older consent pages, direct API callers) → the full intersection,
    // exactly the previous behavior.
    const offered = grantedScopes(scope);
    let scopes = offered;
    if (req.body.scopes !== undefined) {
      const chosen = req.body.scopes;
      if (!Array.isArray(chosen) || chosen.length === 0 || chosen.some((s) => typeof s !== 'string')) {
        return res.status(400).json({ error: 'scopes must be a non-empty array of scope strings' });
      }
      const invalid = chosen.filter((s) => !offered.includes(s));
      if (invalid.length) {
        return res.status(400).json({ error: `scopes not requested by the client: ${invalid.join(', ')}` });
      }
      if (!chosen.includes('read')) {
        return res.status(400).json({ error: 'the read scope is required' });
      }
      scopes = offered.filter((s) => chosen.includes(s)); // canonical order, deduped
    }
    const rawCode = OAuthAuthCode.generateCode();
    await OAuthAuthCode.create({
      codeHash: OAuthAuthCode.hashCode(rawCode),
      clientId: client_id,
      user: req.user.id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: 'S256',
      scopes,
      resource: resource || resourceUrl(),
      expiresAt: new Date(Date.now() + OAuthAuthCode.AUTH_CODE_TTL_MS),
    });

    logAudit(req, 'oauth.consent_granted', { type: 'user', id: req.user.id }, { clientId: client_id, scopes });

    const u = new URL(redirect_uri);
    u.searchParams.set('code', rawCode);
    if (state) u.searchParams.set('state', state);
    return res.json({ redirect: u.toString() });
  } catch (err) {
    console.error('OAuth approve error:', err);
    return res.status(500).json({ error: 'consent failed' });
  }
});

/**
 * Authenticate the client at the token/revoke endpoints. Public clients present
 * only client_id; confidential clients also present client_secret. Returns the
 * OAuthClient doc, or null (caller returns invalid_client).
 */
async function authenticateClient(req) {
  const clientId = req.body.client_id;
  if (!clientId || typeof clientId !== 'string') return null;
  const client = await OAuthClient.findOne({ clientId });
  if (!client) return null;
  if (client.tokenEndpointAuthMethod === 'none') return client; // public — client_id is enough
  const secret = req.body.client_secret;
  if (typeof secret !== 'string' || !client.clientSecretHash) return null;
  // Constant-time compare, same as verifyPkce. (Both sides are SHA-256 hex, so
  // a timing leak would only be over the hash — but keep one habit for every
  // credential comparison rather than reasoning about which ones are safe.)
  const a = Buffer.from(OAuthClient.hashSecret(secret));
  const b = Buffer.from(client.clientSecretHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return client;
}

// ── POST /token — code exchange + refresh rotation ───────────────────────────
router.post('/token', async (req, res) => {
  try {
    const client = await authenticateClient(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'client authentication failed');
    const grantType = req.body.grant_type;

    if (grantType === 'authorization_code') {
      const { code, code_verifier, redirect_uri, resource } = req.body;
      if (!code || !code_verifier) return oauthError(res, 400, 'invalid_request', 'code and code_verifier are required');

      // Single-use: atomically claim the code (consumedAt null → now). A replay
      // or a lost-response retry finds it already consumed and is rejected.
      const codeDoc = await OAuthAuthCode.findOneAndUpdate(
        { codeHash: OAuthAuthCode.hashCode(code), consumedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { consumedAt: new Date() } },
        { new: false }
      );
      if (!codeDoc) return oauthError(res, 400, 'invalid_grant', 'authorization code is invalid, expired, or already used');
      if (codeDoc.clientId !== client.clientId) return oauthError(res, 400, 'invalid_grant', 'code was issued to a different client');
      if (redirect_uri && redirect_uri !== codeDoc.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
      if (!verifyPkce(code_verifier, codeDoc.codeChallenge)) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      if (resource && resource !== (codeDoc.resource || resourceUrl())) return oauthError(res, 400, 'invalid_target', 'resource mismatch');

      // Bound how many live AI connections one account can accrue.
      const activeConnections = await ApiToken.countDocuments({ user: codeDoc.user, origin: 'oauth', revokedAt: null });
      if (activeConnections >= MAX_OAUTH_CONNECTIONS_PER_USER) {
        return oauthError(res, 400, 'invalid_grant', `too many active AI connections (max ${MAX_OAUTH_CONNECTIONS_PER_USER}); revoke one in Settings`);
      }

      const cred = rotateCredentials();
      const token = await ApiToken.create({
        user: codeDoc.user,
        name: client.clientName ? `${client.clientName} (AI)` : 'Connected AI',
        scopes: codeDoc.scopes,
        origin: 'oauth',
        oauthClientId: client.clientId,
        resource: codeDoc.resource || resourceUrl(),
        ...cred.fields,
      });
      // Mark used → make the client permanent (drop the never-used TTL, M-6).
      OAuthClient.updateOne({ _id: client._id }, { $set: { lastUsedAt: new Date() }, $unset: { expiresAt: '' } }).catch(() => {});
      logAudit(req, 'oauth.token_issued', { type: 'apiToken', id: token._id }, { clientId: client.clientId, scopes: codeDoc.scopes });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(tokenResponse(cred.raw.access, cred.raw.refresh, codeDoc.scopes));
    }

    if (grantType === 'refresh_token') {
      const { refresh_token } = req.body;
      if (!refresh_token) return oauthError(res, 400, 'invalid_request', 'refresh_token is required');
      const presented = ApiToken.hashToken(refresh_token);
      // Look up the connection by the CURRENT refresh hash.
      const token = await ApiToken.findOne({ refreshTokenHash: presented, origin: 'oauth', revokedAt: null });

      if (!token) {
        // REUSE DETECTION (OAuth 2.1 security BCP §4.14.2). The token matched no
        // live connection — but if it matches one's PREVIOUS (already-rotated)
        // refresh token, then a spent token is being replayed, which means it
        // leaked: the legitimate client would be holding the rotated successor.
        // We cannot tell thief from victim, so kill the whole connection; both
        // must re-authorize. (Trade-off: a client whose successful rotation
        // response was lost in transit retries with the spent token and also
        // trips this — it re-auths. Rare, and the safe direction to err.)
        const reused = await ApiToken.findOne({
          prevRefreshTokenHash: presented, origin: 'oauth', revokedAt: null, oauthClientId: client.clientId,
        });
        if (reused) {
          reused.revokedAt = new Date();
          await reused.save();
          eventBus.dropToken(reused._id);
          logAudit(req, 'oauth.refresh_reuse_detected', { type: 'apiToken', id: reused._id }, { clientId: client.clientId });
        }
        return oauthError(res, 400, 'invalid_grant', 'refresh token is invalid or revoked');
      }
      if (token.oauthClientId !== client.clientId) {
        return oauthError(res, 400, 'invalid_grant', 'refresh token is invalid or revoked');
      }

      // Rotate BOTH tokens (OAuth 2.1 §4.3.1), remembering the spent refresh
      // hash so a later replay of it is caught above. A concurrent double-
      // refresh is guarded by pinning the old hash in the update filter — only
      // one wins, and the loser gets invalid_grant WITHOUT tripping reuse
      // detection (it already matched the current hash on the read above).
      const cred = rotateCredentials();
      const rotated = await ApiToken.findOneAndUpdate(
        { _id: token._id, refreshTokenHash: token.refreshTokenHash, revokedAt: null },
        { $set: { ...cred.fields, prevRefreshTokenHash: token.refreshTokenHash } },
        { new: true }
      );
      if (!rotated) return oauthError(res, 400, 'invalid_grant', 'refresh token is invalid or revoked');
      logAudit(req, 'oauth.token_refreshed', { type: 'apiToken', id: token._id }, { clientId: client.clientId });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(tokenResponse(cred.raw.access, cred.raw.refresh, rotated.scopes));
    }

    return oauthError(res, 400, 'unsupported_grant_type', 'only authorization_code and refresh_token are supported');
  } catch (err) {
    console.error('OAuth token error:', err);
    return oauthError(res, 500, 'server_error', 'token request failed');
  }
});

// ── POST /revoke — RFC 7009 ──────────────────────────────────────────────────
router.post('/revoke', async (req, res) => {
  try {
    const client = await authenticateClient(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'client authentication failed');
    const { token } = req.body;
    if (token) {
      // Match either an access token (tokenHash) or a refresh token
      // (refreshTokenHash), but only this client's own OAuth connections.
      const hash = ApiToken.hashToken(token);
      const doc = await ApiToken.findOne({
        oauthClientId: client.clientId,
        origin: 'oauth',
        revokedAt: null,
        $or: [{ tokenHash: hash }, { refreshTokenHash: hash }],
      });
      if (doc) {
        doc.revokedAt = new Date();
        await doc.save();
        eventBus.dropToken(doc._id);
        logAudit(req, 'oauth.token_revoked', { type: 'apiToken', id: doc._id }, { clientId: client.clientId });
      }
    }
    // RFC 7009: always 200, even for an unknown token.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({});
  } catch (err) {
    console.error('OAuth revoke error:', err);
    return oauthError(res, 500, 'server_error', 'revocation failed');
  }
});

module.exports = router;
