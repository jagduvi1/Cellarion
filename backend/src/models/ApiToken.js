const mongoose = require('mongoose');
const crypto = require('crypto');

// Personal API tokens ("cel_..." bearer credentials) for machine clients such
// as the Home Assistant integration. Design notes (docs/ha-push-events.md §3):
//
// - The raw token is `cel_` + 32 random bytes hex (256 bits of entropy). Only
//   its SHA-256 is stored — unlike passwords, high-entropy random tokens don't
//   need a slow hash, and a fast hash keeps per-request auth at microseconds
//   instead of bcrypt's ~250 ms. The plaintext is shown exactly once, at
//   creation.
// - Tokens are SCOPED (default-deny): the auth middleware only accepts them on
//   routes explicitly allowlisted for one of the token's scopes — see
//   middleware/apiTokenAuth.js. A leaked read+consume token cannot touch
//   account settings, exports, or any other mutation.
// - Revocation is a soft flag (revokedAt) so the Settings UI can show a
//   revocation trail; all rows are hard-deleted on account erasure via
//   userDataRegistry.js.

const TOKEN_PREFIX = 'cel_';
const TOKEN_SCOPES = ['read', 'consume', 'climate'];
const MAX_ACTIVE_TOKENS_PER_USER = 10;

const apiTokenSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Token name is required'],
    trim: true,
    maxlength: [100, 'Token name too long'],
  },
  tokenHash: {
    type: String,
    required: true,
    unique: true,
  },
  scopes: {
    type: [String],
    enum: TOKEN_SCOPES,
    required: true,
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: 'Token must have at least one scope',
    },
  },
  // Throttled to at most one write per hour by the auth middleware, so a
  // 30-minute poller doesn't turn every request into a DB write.
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
});

/** SHA-256 hex of a raw token — the only form ever stored or queried. */
apiTokenSchema.statics.hashToken = function (rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

/** Generate a new raw token. Returned to the caller ONCE; never stored. */
apiTokenSchema.statics.generateToken = function () {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
};

module.exports = mongoose.model('ApiToken', apiTokenSchema);
module.exports.TOKEN_PREFIX = TOKEN_PREFIX;
module.exports.TOKEN_SCOPES = TOKEN_SCOPES;
module.exports.MAX_ACTIVE_TOKENS_PER_USER = MAX_ACTIVE_TOKENS_PER_USER;
