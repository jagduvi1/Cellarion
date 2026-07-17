const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * OAuthClient — an OAuth 2.1 client registered via Dynamic Client Registration
 * (RFC 7591) at POST /api/mcp/oauth/register. This is how claude.ai / ChatGPT /
 * Claude Desktop obtain a `client_id` for the one-click MCP connector, with no
 * manual setup (MCP Authorization spec, plan §2.4 Phase B).
 *
 * DCR is UNAUTHENTICATED and pre-account: the client registers before any user
 * has logged in, so there is no user ref here (the user binding happens later,
 * on the authorization code and the issued token). That also means these rows
 * are NOT personal data — they hold a connector's redirect URIs and name, not a
 * person's — so they are EXCLUDED from the GDPR export/erasure registry.
 *
 * Registration is open (spec-required for one-click connect) but bounded: rate-
 * limited at the route, redirect URIs are validated to https/loopback, and a
 * client grants NOTHING on its own — every token still requires a logged-in
 * user to approve consent at /authorize. A spammed client row is inert.
 */
const oauthClientSchema = new mongoose.Schema({
  // Public identifier handed back to the client. Random, unguessable.
  clientId: { type: String, required: true, unique: true },
  clientName: { type: String, default: null, maxlength: 200 },
  // Exact-match allowlist for the redirect after consent. Validated at
  // registration (https or loopback only) and exact-matched at /authorize.
  redirectUris: { type: [String], required: true },
  // 'none' = public client (PKCE-only, the claude.ai/ChatGPT default); the
  // secret methods are for confidential clients.
  tokenEndpointAuthMethod: {
    type: String,
    enum: ['none', 'client_secret_post', 'client_secret_basic'],
    default: 'none',
  },
  // SHA-256 of the client secret (confidential clients only; null for public).
  // Like every other credential here, the plaintext is shown once at register.
  clientSecretHash: { type: String, default: null },
  grantTypes: { type: [String], default: ['authorization_code', 'refresh_token'] },
  responseTypes: { type: [String], default: ['code'] },
  softwareId: { type: String, default: null },
  softwareVersion: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null },
  // Reap NEVER-USED clients only (security audit M-6): set to now+30d at
  // registration and UNSET the first time the client completes a token
  // exchange, so an actively-connected client persists forever and is never
  // orphaned while a live token references it. TTL-at-date (expireAfterSeconds
  // 0); a document with expiresAt null/absent is never expired.
  expiresAt: { type: Date, default: null },
});

oauthClientSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Random public client id. Prefixed for readability in logs/DB. */
oauthClientSchema.statics.generateClientId = function () {
  return 'mcpc_' + crypto.randomBytes(24).toString('hex');
};
/** Random client secret (confidential clients). Returned once, hashed at rest. */
oauthClientSchema.statics.generateClientSecret = function () {
  return crypto.randomBytes(32).toString('hex');
};
oauthClientSchema.statics.hashSecret = function (raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
};

module.exports = mongoose.model('OAuthClient', oauthClientSchema);
