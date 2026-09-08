const mongoose = require('mongoose');
const crypto = require('crypto');

// Registry Bridge keys ("cbr_..." bearer credentials) — the permit a
// self-hosted Cellarion presents to cellarion.app to search the shared
// registry, fetch single wines, check changes for wines it holds and forward
// contributions (REGISTRY_LOCKDOWN_PLAN §6, decided 2026-09-06).
//
// Deliberately a separate model from ApiToken, not an `origin: 'bridge'` row:
// the two credentials have different prefixes (the auth path dispatches on the
// prefix), different caps (2 per account here, 10 there, and a bridge key must
// not eat the personal-token budget), a different audience (only
// /api/bridge/v1, enforced by mounting the auth middleware on that router and
// nowhere else) and different bookkeeping (usage quotas, terms version,
// instance host).
//
// Same credential hygiene as ApiToken: the raw key is `cbr_` + 32 random bytes
// hex, only its SHA-256 is stored, the plaintext is shown once at creation,
// and a short display prefix is kept so the owner can tell keys apart.
// Revocation is a soft flag; rows are hard-deleted on account erasure via
// services/userDataRegistry.js.

const KEY_PREFIX = 'cbr_';
const MAX_ACTIVE_PER_USER = 2;
const NAME_MAX = 60;
const REVOKE_REASON_MAX = 300;
const PREFIX_DISPLAY_LENGTH = 12; // "cbr_" + 8 hex chars

const bridgeKeySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // The install's label, chosen by the owner ("Home NAS", "Club cellar").
  name: {
    type: String,
    required: [true, 'Key name is required'],
    trim: true,
    maxlength: [NAME_MAX, 'Key name too long'],
  },
  keyHash: {
    type: String,
    required: true,
    unique: true,
  },
  // First characters of the raw key — enough to recognise it in a .env file,
  // useless for authenticating.
  prefix: {
    type: String,
    required: true,
  },
  // Reported by the self-hosted backend (X-Cellarion-Instance), sanitised.
  // Attribution for contributions and the daily readers report.
  instanceHost: {
    type: String,
    default: null,
    maxlength: 120,
  },
  // The Registry Data Terms version the owner accepted when this key was
  // issued. A terms bump means new keys carry the new version; existing keys
  // keep the version they were issued under until the owner re-accepts.
  termsVersion: {
    type: String,
    required: true,
  },
  termsAcceptedAt: {
    type: Date,
    required: true,
  },
  // Import window: once a month the owner can raise the daily quotas ×5 for
  // 24 hours to import a whole cellar. Adding bottles must stay painless.
  importWindowUntil: {
    type: Date,
    default: null,
  },
  importWindowOpenedAt: {
    type: Date,
    default: null,
  },
  // Throttled to at most one write per hour by the auth middleware.
  lastUsedAt: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  revokedAt: {
    type: Date,
    default: null,
  },
  // Set only when an ADMIN revoked the key (routes/admin/bridge.js): who and
  // why. The owner is shown the reason in Settings for a while; a key the
  // owner revoked themselves leaves both empty.
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  revokedReason: {
    type: String,
    default: null,
    maxlength: REVOKE_REASON_MAX,
  },
});

bridgeKeySchema.index({ user: 1, revokedAt: 1 });

/** SHA-256 hex of a raw key — the only form ever stored or queried. */
bridgeKeySchema.statics.hashKey = function (rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
};

/** Generate a new raw key. Returned to the owner ONCE; never stored. */
bridgeKeySchema.statics.generateKey = function () {
  return KEY_PREFIX + crypto.randomBytes(32).toString('hex');
};

/** The display prefix stored next to the hash. */
bridgeKeySchema.statics.displayPrefix = function (rawKey) {
  return String(rawKey).slice(0, PREFIX_DISPLAY_LENGTH);
};

bridgeKeySchema.statics.KEY_PREFIX = KEY_PREFIX;
bridgeKeySchema.statics.MAX_ACTIVE_PER_USER = MAX_ACTIVE_PER_USER;
bridgeKeySchema.statics.NAME_MAX = NAME_MAX;
bridgeKeySchema.statics.REVOKE_REASON_MAX = REVOKE_REASON_MAX;

module.exports = mongoose.model('BridgeKey', bridgeKeySchema);
