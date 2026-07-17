const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * OAuthAuthCode — a single-use OAuth 2.1 authorization code (RFC 6749 §4.1),
 * minted at POST /api/mcp/oauth/approve after the logged-in user consents, and
 * exchanged for tokens at /token. Short-lived and PKCE-bound.
 *
 * Security shape (mirrors ApiToken): only the SHA-256 of the code is stored;
 * the plaintext lives only in the redirect back to the client. `consumedAt`
 * makes it single-use — a replayed code is rejected. The stored codeChallenge
 * (RFC 7636) is verified against the client's code_verifier at exchange. The
 * code is bound to exactly one client + redirectUri + user + scopes + resource,
 * so none of those can be swapped at the token step.
 *
 * TTL: 5 minutes (well under the OAuth 2.1 "SHOULD be short" guidance). The TTL
 * index reaps expired codes; the expiresAt check at exchange is the real guard.
 * GDPR: has a user ref, so it is registered in userDataRegistry (purged on
 * account deletion); nothing to export (an ephemeral, already-redeemed or
 * expired credential is not meaningful personal data).
 */
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

const oauthAuthCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true },
  clientId: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  redirectUri: { type: String, required: true },
  codeChallenge: { type: String, required: true },
  codeChallengeMethod: { type: String, enum: ['S256'], default: 'S256' },
  scopes: { type: [String], required: true },
  resource: { type: String, default: null },
  consumedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

// TTL — single index on expiresAt (a competing plain index silently disables
// TTL; see models/McpActionLog.js). Reaps expired/spent codes.
oauthAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

oauthAuthCodeSchema.statics.generateCode = function () {
  return crypto.randomBytes(32).toString('hex');
};
oauthAuthCodeSchema.statics.hashCode = function (raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
};

module.exports = mongoose.model('OAuthAuthCode', oauthAuthCodeSchema);
module.exports.AUTH_CODE_TTL_MS = AUTH_CODE_TTL_MS;
