const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { CURRENT_PRIVACY_POLICY_VERSION } = require('../config/legal');

// Single source of truth for the bcrypt work factor. The login route's dummy
// hash (routes/auth.js) MUST be generated at this same cost — a cheaper dummy
// compare responds measurably faster for unknown identifiers, reintroducing
// the timing-based account-enumeration oracle the dummy exists to close (L-1).
const BCRYPT_COST = 12;

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    lowercase: true,
    minlength: [3, 'Username must be at least 3 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Please enter a valid email']
  },
  // Local password. Required for classic email+password accounts, but OPTIONAL
  // for accounts created via an external identity provider (SSO) — those carry
  // an entry in `authProviders` and have no password. `required` is a function
  // so it only fires when the account has no linked provider. A local user may
  // still ALSO link providers later (password stays set).
  password: {
    type: String,
    required: [
      function () { return !Array.isArray(this.authProviders) || this.authProviders.length === 0; },
      'Password is required'
    ],
    validate: {
      // Skip complexity when there is no password (SSO-only account); Mongoose
      // also skips custom validators for undefined, but guard explicitly so an
      // empty-string never slips through.
      validator: (v) => v == null || /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{12,}$/.test(v),
      message: 'Password must be at least 12 characters and include an uppercase letter, lowercase letter, number, and special character'
    }
  },
  // External identity providers linked to this account (SSO). Each entry ties a
  // provider's stable user id to this account so a returning user is matched
  // back to the same Cellarion account. Empty for classic email+password users.
  authProviders: {
    type: [
      new mongoose.Schema(
        {
          provider: { type: String, enum: ['google'], required: true },
          providerId: { type: String, required: true },
          linkedAt: { type: Date, default: Date.now }
        },
        { _id: false }
      )
    ],
    default: []
  },
  roles: {
    type: [String],
    enum: ['user', 'somm', 'admin', 'moderator'],
    default: ['user'],
    index: true,
    validate: {
      validator: (arr) => arr.length > 0,
      message: 'User must have at least one role'
    }
  },
  plan: {
    type: String,
    enum: ['free', 'supporter', 'patron'],
    default: 'free'
  },
  planStartedAt: {
    type: Date,
    default: null
  },
  planExpiresAt: {
    type: Date,
    default: null   // null = no expiry (indefinite)
  },
  stripeCustomerId: {
    type: String,
    default: null
  },
  stripeSubscriptionId: {
    type: String,
    default: null
  },
  preferences: {
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true
    },
    language: {
      type: String,
      default: 'en',
      trim: true
    },
    ratingScale: {
      type: String,
      enum: ['5', '20', '100'],
      default: '5'
    },
    defaultCellarId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cellar',
      default: null
    },
    rackNavigation: {
      type: String,
      enum: ['auto', 'room', 'rack'],
      default: 'auto'
    },
    notifications: {
      // In-app notifications (the bell) are always on for every category —
      // they're a pull surface, not interruptive. The toggles below gate
      // outbound channels (email, push) per category.
      //
      // Defaults: drink-window stays opt-in (existing behaviour); community
      // categories default ON for push (push is already explicit-subscription
      // gated, so it's safe to opt in once subscribed) and OFF for email
      // (email is the more intrusive channel — opt in if you want it).
      drinkWindow: {
        // Master toggle (back-compat with the old single boolean — still drives
        // the in-app bell; the email/push children gate outbound channels).
        enabled: { type: Boolean, default: true },
        email:   { type: Boolean, default: false },
        push:    { type: Boolean, default: false }
      },
      communityReply: {
        // Reply to your discussion, or someone quoted your reply.
        email: { type: Boolean, default: false },
        push:  { type: Boolean, default: true }
      },
      communityMention: {
        // @mentioned you anywhere.
        email: { type: Boolean, default: false },
        push:  { type: Boolean, default: true }
      },
      communityFollow: {
        // New reply on a thread you're following (and didn't author).
        // Email skipped — would be too noisy.
        push:  { type: Boolean, default: true }
      }
    },
    restockScope: {
      type: String,
      enum: ['all', 'cellar'],
      default: 'all'
    }
  },
  refreshTokenHash: {
    type: String,
    default: null
  },
  // Absolute session deadline: a refresh token can be rotated only until this
  // time, after which re-login is forced regardless of activity. Set at session
  // start (login/register) and preserved across rotations. null = no cap yet
  // (legacy sessions; backfilled on next refresh).
  refreshTokenExpiresAt: {
    type: Date,
    default: null
  },
  // Whether the session's refresh cookie is persistent (remember-me) or a
  // browser-session cookie. Set at login and read on rotation paths so
  // /refresh doesn't silently upgrade a session cookie to persistent.
  // null = legacy session (treated as persistent).
  refreshTokenPersistent: {
    type: Boolean,
    default: null
  },
  // Per-account brute-force lockout state. Incremented on each failed login,
  // reset on success or successful password reset. Surfaced via the lockout
  // checks in utils/loginAttempts.js — the login handler treats a locked
  // account exactly like a wrong password (same generic 401, same latency)
  // so an attacker can't tell when they've tripped a lockout.
  failedLoginAttempts: {
    count:              { type: Number, default: 0 },
    firstFailedAt:      { type: Date,   default: null },
    lockedUntil:        { type: Date,   default: null },
    lockoutEmailSentAt: { type: Date,   default: null },  // dedupes the alert email
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationTokenHash: {
    type: String,
    default: null
  },
  emailVerificationExpiresAt: {
    type: Date,
    default: null
  },
  passwordResetTokenHash: {
    type: String,
    default: null
  },
  passwordResetExpiresAt: {
    type: Date,
    default: null
  },
  displayName: {
    type: String,
    trim: true,
    maxlength: [50, 'Display name too long'],
    default: null
  },
  bio: {
    type: String,
    trim: true,
    maxlength: [500, 'Bio too long'],
    default: null
  },
  followersCount: {
    type: Number,
    default: 0
  },
  followingCount: {
    type: Number,
    default: 0
  },
  reviewCount: {
    type: Number,
    default: 0
  },
  // Cellar Cred — contribution score and badge system
  contribution: {
    totalScore:  { type: Number, default: 0 },
    categories: {
      curator:      { type: Number, default: 0 },
      photographer: { type: Number, default: 0 },
      critic:       { type: Number, default: 0 },
      community:    { type: Number, default: 0 },
    },
    tier: {
      type: String,
      enum: ['newcomer', 'contributor', 'enthusiast', 'connoisseur', 'ambassador'],
      default: 'newcomer',
    },
    specialty: {
      type: String,
      enum: [null, 'curator', 'photographer', 'critic', 'community', 'allrounder'],
      default: null,
    },
  },
  profileVisibility: {
    type: String,
    enum: ['public', 'private'],
    default: 'public'
  },
  // Discussion ban: blocks posting in discussions
  discussionBan: {
    active: { type: Boolean, default: false },
    reason: { type: String, default: null },
    bannedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null }, // null = permanent
    bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  // Temporary per-user override of the daily AI budget (services/aiBudget.js),
  // granted by an admin approving an AiBudgetRequest. No defaults are
  // persisted — the subdocument is absent on users without a grant. An
  // expired override (expiresAt <= now) is simply ignored by the budget
  // check; no cleanup job is needed.
  aiBudgetOverride: {
    max:       { type: Number },
    expiresAt: { type: Date },
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  // GDPR consent tracking
  gdprConsent: {
    privacyPolicy: {
      accepted: { type: Boolean, default: false },
      acceptedAt: { type: Date, default: null },
      version: { type: String, default: null }  // e.g. '2026-03'
    },
    dataProcessing: {
      accepted: { type: Boolean, default: false },
      acceptedAt: { type: Date, default: null }
    }
  },
  // Scheduled deletion (GDPR right to erasure with cooling-off)
  deletionRequestedAt: {
    type: Date,
    default: null
  },
  deletionScheduledFor: {
    type: Date,
    default: null
  },
  // Last time the user pulled a full export with image files. Used to enforce a
  // once-per-week limit on that endpoint (the archive can be hundreds of MB).
  // Stored on the account so the limit survives restarts and is per-user, not
  // per-IP like the global rate limiters.
  lastImageExportAt: {
    type: Date,
    default: null
  },
  // Last time an MCP export-link for the full GDPR account export was minted.
  // That build spans ~35 collections and can be hundreds of MB, so the MCP
  // path (an automated caller that could loop) throttles it to once per day.
  // The web route GET /api/users/me/export stays unthrottled — a human clicking
  // download is not the threat model this bounds.
  lastAccountExportAt: {
    type: Date,
    default: null
  },
  // ─── Ephemeral public demo accounts ──────────────────────────────────────
  // A demo account is a throwaway, auto-expiring user created by
  // POST /api/auth/demo-login so anonymous visitors can try Cellarion with a
  // fully-populated (cloned) cellar without signing up. `isDemo` gates a set of
  // server-side guard rails (no password/account changes, no API tokens, no AI
  // spend) and `demoExpiresAt` drives the demoSweepJob reaper, which fully
  // erases the user + every cloned document via purgeUserData once the window
  // passes. Never granted the somm/admin role; never mailed (unroutable address).
  isDemo: {
    type: Boolean,
    default: false
  },
  demoExpiresAt: {
    type: Date,
    default: null
  }
});

// Sparse index so verify-email lookup is efficient; sparse avoids bloat after verification
userSchema.index({ emailVerificationTokenHash: 1 }, { sparse: true });
userSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });
// Every /api/auth/refresh resolves the session via this hash — without the
// index it is a full collection scan per token refresh (one per session ~15min)
userSchema.index({ refreshTokenHash: 1 }, { sparse: true });
// SSO login resolves the account by (provider, provider's user id) on every
// federated sign-in — index it so that lookup isn't a full collection scan.
userSchema.index({ 'authProviders.provider': 1, 'authProviders.providerId': 1 });
// The demoSweepJob reaper queries { isDemo: true, demoExpiresAt: { $lte: now } }
// every ~15 min, and demo-login counts live demos ({ isDemo: true }) to enforce
// the global concurrency ceiling. A partial index keyed to demo rows keeps both
// cheap and stays empty (zero bytes) for the overwhelming majority of real users.
userSchema.index({ demoExpiresAt: 1 }, { partialFilterExpression: { isDemo: true } });

// Heal legacy notification-pref shapes before save. Old docs stored
// `drinkWindow: false` (single boolean); the current schema expects
// `{ enabled, email, push }`. Without this, Mongoose generates dotted $set
// sub-paths and MongoDB throws "Cannot create field 'email' in element
// {drinkWindow: false}". See issue #390.
//
// Mutates `notif` in place. Returns the list of top-level keys that were
// rewritten so the caller can markModified() each parent path — this forces
// Mongoose to write a whole-object replacement instead of dotted sub-paths.
function normalizeLegacyNotifications(notif) {
  if (!notif) return [];
  const changed = [];
  if (typeof notif.drinkWindow === 'boolean') {
    notif.drinkWindow = { enabled: notif.drinkWindow, email: false, push: false };
    changed.push('drinkWindow');
  }
  for (const key of ['communityReply', 'communityMention', 'communityFollow']) {
    if (typeof notif[key] === 'boolean') {
      const truthy = notif[key];
      notif[key] = key === 'communityFollow'
        ? { push: truthy }
        : { email: false, push: truthy };
      changed.push(key);
    }
  }
  return changed;
}

userSchema.pre('save', function(next) {
  const notif = this.preferences && this.preferences.notifications;
  const changed = normalizeLegacyNotifications(notif);
  for (const key of changed) {
    this.markModified('preferences.notifications.' + key);
  }
  next();
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  // Only hash if password is modified or new
  if (!this.isModified('password')) {
    return next();
  }

  // Ephemeral demo accounts skip the expensive bcrypt hash entirely: they never
  // password-login (JWT only, on an unroutable address), and under a burst of
  // demo-logins N parallel cost-12 hashes on the single Node thread would degrade
  // latency for everyone. The demo's random password is complexity-valid (so it
  // passes the schema validator, which re-runs on the later issueTokens save) but
  // is left UNHASHED — it is never used, and comparePassword returns false against
  // a non-bcrypt value, so it can never authenticate. (Do NOT substitute a fixed
  // sentinel here: full-document validation on the next save would reject it.)
  if (this.isDemo) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(BCRYPT_COST);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password for login. Returns false for SSO-only accounts
// (no local password) instead of throwing on a bcrypt.compare against undefined.
userSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

// Store a hashed refresh token
userSchema.methods.setRefreshToken = function(token) {
  this.refreshTokenHash = crypto.createHash('sha256').update(token).digest('hex');
};

// Validate a refresh token against the stored hash
userSchema.methods.validateRefreshToken = function(token) {
  if (!this.refreshTokenHash) return false;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.refreshTokenHash));
};

// Generate a raw verification token, store its hash, set 24h expiry; returns raw token to email
userSchema.methods.setEmailVerificationToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.emailVerificationTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  this.emailVerificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return token;
};

// Validate a candidate token against the stored hash and expiry
userSchema.methods.validateEmailVerificationToken = function(candidateToken) {
  if (!this.emailVerificationTokenHash || !this.emailVerificationExpiresAt) return false;
  if (Date.now() > this.emailVerificationExpiresAt.getTime()) return false;
  const hash = crypto.createHash('sha256').update(candidateToken).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.emailVerificationTokenHash));
};

// Generate a raw password-reset token, store its hash, set 1h expiry; returns raw token to email
userSchema.methods.setPasswordResetToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.passwordResetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  this.passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  return token;
};

// Validate a password-reset token against the stored hash and expiry
userSchema.methods.validatePasswordResetToken = function(candidateToken) {
  if (!this.passwordResetTokenHash || !this.passwordResetExpiresAt) return false;
  if (Date.now() > this.passwordResetExpiresAt.getTime()) return false;
  const hash = crypto.createHash('sha256').update(candidateToken).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(this.passwordResetTokenHash));
};

// Check if user is currently banned from discussions
userSchema.methods.isDiscussionBanned = function() {
  if (!this.discussionBan || !this.discussionBan.active) return false;
  // If expiresAt is set and in the past, ban has expired
  if (this.discussionBan.expiresAt && this.discussionBan.expiresAt < new Date()) return false;
  return true;
};

// Remove sensitive fields from JSON responses
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  // toObject() omits the `id` virtual, but the frontend's ownership checks
  // compare against `user.id` — expose it as a plain string alongside _id.
  if (obj._id) obj.id = obj._id.toString();
  // Whether the account can log in with a password. false = SSO-only, so the UI
  // can hide "change password" and show "set a password" instead. Compute before
  // password is stripped below.
  obj.hasPassword = !!obj.password;
  // Surface only the linked provider NAMES (e.g. ['google']) — never the raw
  // provider ids — so the UI can show "Connected: Google".
  obj.linkedProviders = Array.isArray(obj.authProviders) ? obj.authProviders.map(p => p.provider) : [];
  delete obj.authProviders;
  delete obj.password;
  delete obj.refreshTokenHash;
  delete obj.refreshTokenExpiresAt;
  delete obj.refreshTokenPersistent;
  delete obj.emailVerificationTokenHash;
  delete obj.emailVerificationExpiresAt;
  delete obj.passwordResetTokenHash;
  delete obj.passwordResetExpiresAt;
  delete obj.stripeCustomerId;
  // Data minimisation (I-1): internal lockout bookkeeping and the raw Stripe
  // subscription id are never needed client-side. The frontend only needs to
  // know WHETHER a subscription exists — expose that as a derived boolean.
  delete obj.failedLoginAttempts;
  delete obj.stripeSubscriptionId;
  obj.hasStripeSubscription = !!this.stripeSubscriptionId;
  // True when the user hasn't accepted the current privacy-policy version (older
  // version, never recorded, or not accepted at all) — the client prompts them to
  // review and acknowledge the update. Derived, never stored.
  const pp = obj.gdprConsent?.privacyPolicy;
  obj.requiresPolicyReconsent = !pp?.accepted || (pp?.version || null) !== CURRENT_PRIVACY_POLICY_VERSION;
  // Surface the demo flag as a clean boolean so the frontend can show the
  // persistent "demo resets" banner and hide restricted actions. demoExpiresAt
  // rides along on obj (null for real users) so the banner can show a countdown.
  obj.isDemo = !!obj.isDemo;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
module.exports.normalizeLegacyNotifications = normalizeLegacyNotifications;
module.exports.BCRYPT_COST = BCRYPT_COST;
