const mongoose = require('mongoose');

/**
 * ExportLink — a short-lived, single-purpose download URL for a data export
 * requested over MCP (plan §3.3 `export_cellar`, §3.18 `get_account_export`).
 *
 * Why a link instead of returning the export itself: an export is a FILE, not
 * model context. The cellar payload is capped at 50k documents and the account
 * export spans ~35 collections — either can run to hundreds of MB, which would
 * blow up the caller's context window (and our memory) if inlined into a tool
 * result. Plan principle #7 is explicit: compact payloads, never giant dumps.
 * So the tool returns counts + this link, the user opens it, and the bytes go
 * from us straight to their disk — never through the model. That also keeps the
 * account export's PII (email, audit history) out of the third-party AI
 * entirely: the assistant hands over a URL it cannot usefully read itself.
 *
 * Why its own credential and not a JWT: a signed JWT bearing the user's id
 * would be accepted by requireAuth as a session — an export URL sitting in
 * chat logs, browser history and proxy logs must never be a login. An opaque
 * random token in a dedicated collection cannot be confused for one, and it is
 * revocable and auditable, which a stateless signature is not.
 *
 * Security shape (mirrors models/ApiToken.js): `celx_` + 32 random bytes, only
 * the SHA-256 stored — high-entropy randoms don't need a slow hash. The
 * plaintext exists only in the tool result. Rows self-destruct at expiresAt
 * (TTL below), so an abandoned link cannot be redeemed later.
 *
 * Re-downloadable within its window ON PURPOSE: a multi-hundred-MB ZIP that
 * dies at 90% must be retryable. The window is the bound, not a use counter.
 * The expensive per-week/per-day allowances are claimed at download time on the
 * User doc (lastImageExportAt / lastAccountExportAt), so minting links is cheap
 * and only real downloads are charged.
 *
 * GDPR: registered in services/userDataRegistry.js — purged on account
 * deletion, excluded from the export (an ephemeral credential is not user data).
 */
const exportLinkSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  // What the redeemer should build. cellar_* honour cellarScope; account_json
  // is the whole-account GDPR payload.
  kind: { type: String, enum: ['cellar_json', 'cellar_zip', 'account_json'], required: true },
  // 'all' or a cellar ObjectId string — frozen at mint time so the redeemer
  // cannot be steered to a different cellar by tampering with the URL.
  cellarScope: { type: String, default: 'all' },
  // The cel_ token that requested it; null for a browser (JWT) session.
  // Provenance only — never the token itself.
  tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiToken', default: null },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  downloads: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

// TTL: delete the row the moment it expires. Single index on expiresAt — a
// competing plain index silently disables TTL (IndexOptionsConflict; see
// models/AuditLog.js and models/McpActionLog.js for the same note).
exportLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ExportLink', exportLinkSchema);
