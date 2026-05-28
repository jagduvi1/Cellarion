/**
 * In-memory cache for rate limit configuration.
 * Loaded once from MongoDB on startup; updated instantly when admin saves new values.
 * Falls back to defaults if the DB is unavailable.
 */

const defaults = {
  api:   { max: 200 },
  write: { max: 60 },
  auth:  { max: 10 },
  // Per-account brute-force protection. Tracks failed login attempts on the
  // User document so a credential-stuffing attacker rotating IPs can't bypass
  // the per-IP authLimiter. See utils/loginAttempts.js for the enforcement.
  accountLockout: {
    threshold:    10,               // failed attempts before lockout
    windowMs:     15 * 60 * 1000,   // count attempts within a 15-min window
    durationMs:   60 * 60 * 1000,   // lock the account for 1 hour
    emailDedupMs: 60 * 60 * 1000,   // send at most one lockout email per hour
  }
};

let cache = {
  api:   { max: defaults.api.max },
  write: { max: defaults.write.max },
  auth:  { max: defaults.auth.max },
  accountLockout: { ...defaults.accountLockout }
};

async function load() {
  try {
    // Lazy require to avoid circular dependency at module load time
    const SiteConfig = require('../models/SiteConfig');
    const doc = await SiteConfig.findOne({ key: 'rateLimits' });
    if (doc && doc.value) {
      cache = {
        api:   { max: doc.value.api?.max   ?? defaults.api.max   },
        write: { max: doc.value.write?.max ?? defaults.write.max },
        auth:  { max: doc.value.auth?.max  ?? defaults.auth.max  },
        accountLockout: {
          threshold:    doc.value.accountLockout?.threshold    ?? defaults.accountLockout.threshold,
          windowMs:     doc.value.accountLockout?.windowMs     ?? defaults.accountLockout.windowMs,
          durationMs:   doc.value.accountLockout?.durationMs   ?? defaults.accountLockout.durationMs,
          emailDedupMs: doc.value.accountLockout?.emailDedupMs ?? defaults.accountLockout.emailDedupMs,
        }
      };
    }
  } catch (err) {
    console.warn('[rateLimits] Could not load config from DB, using defaults:', err.message);
  }
}

function get() {
  return cache;
}

function set(value) {
  cache = value;
}

module.exports = { load, get, set, defaults };
