'use strict';

/**
 * Ephemeral public-demo accounts.
 *
 * POST /api/auth/demo-login creates a throwaway, auto-expiring User and clones a
 * frozen, PII-scrubbed snapshot cellar into it so an anonymous visitor can try
 * Cellarion with a fully-populated cellar — no signup. The account is stamped
 * `isDemo` + `demoExpiresAt`; the demoSweepJob reaper (services/demoSweepJob.js)
 * fully erases the user + all cloned data via purgeUserData once the window
 * passes. Concurrent visitors each get a fresh, isolated userId, so demos never
 * collide.
 *
 * Cost/abuse posture: the clone is registry-safe (never mints registry rows,
 * see cellarImport demoMode) and JSON-only (no per-visitor image files); demo
 * users get zero AI (guard rails elsewhere). Volume is bounded by the per-IP
 * demoLimiter + a durable global ceiling + a short TTL — all in config/rateLimits.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const User = require('../models/User');
const { parseCellarExport, importCellar } = require('./cellarImport');
const rateLimitsConfig = require('../config/rateLimits');
const { CURRENT_PRIVACY_POLICY_VERSION } = require('../config/legal');

// The frozen demo cellar cloned into every ephemeral account: a
// `cellarion-export@1` document (see services/cellarExport.js). Captured once
// from a curated prod cellar, scrubbed of personal/financial free-text, and
// validated so every wine resolves to an EXISTING registry entry
// (scripts/validate-demo-snapshot.js). Loaded + parsed once and cached — it
// never changes at runtime.
const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'demo-snapshot.json');

// Unroutable, RFC 6761-reserved TLD: a demo account can never be emailed.
const DEMO_EMAIL_DOMAIN = 'demo.cellarion.invalid';

let cachedSnapshot = null;
/** Read + parse the snapshot fixture once; cached for the process lifetime. */
function loadSnapshot() {
  if (cachedSnapshot) return cachedSnapshot;
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  cachedSnapshot = parseCellarExport(raw); // { cellars: [...] }
  return cachedSnapshot;
}

/** Count currently-live demo accounts, for the global concurrency ceiling.
 *  Counts expired-but-not-yet-reaped demos too, since they still occupy the DB. */
function countLiveDemos() {
  return User.countDocuments({ isDemo: true });
}

/**
 * Create a throwaway ephemeral demo user and clone the frozen snapshot cellar
 * into it (registry-safe, JSON-only). Returns the saved User WITHOUT issuing
 * tokens — the caller issues them via authTokens.issueTokens so the demo session
 * is byte-for-byte identical to a normal login session.
 */
async function createDemoAccount() {
  const ttlMs = rateLimitsConfig.get().demo.ttlMs;
  const rand = crypto.randomBytes(8).toString('hex'); // 16 hex chars → unique username/email
  const now = new Date();

  const user = new User({
    username: `demo-${rand}`,
    email: `demo-${rand}@${DEMO_EMAIL_DOMAIN}`,
    // The schema requires a password; a demo logs in via JWT only and the address
    // is unroutable, so this value is never used for anything. Random + discarded.
    password: crypto.randomBytes(24).toString('hex'),
    roles: ['user'],
    emailVerified: true,
    isDemo: true,
    demoExpiresAt: new Date(now.getTime() + ttlMs),
    // Consent is recorded so downstream consent checks behave; the demo notice in
    // the connect/landing UI explains the ephemeral nature to the visitor.
    gdprConsent: {
      privacyPolicy: { accepted: true, acceptedAt: now, version: CURRENT_PRIVACY_POLICY_VERSION },
      dataProcessing: { accepted: true, acceptedAt: now },
    },
  });
  await user.save();

  // Clone the snapshot cellars in registry-safe demo mode. A clone hiccup is
  // non-fatal: a demo with fewer bottles still works, and we never want a snapshot
  // problem to 500 the "try the demo" click. The account is created either way and
  // will be reaped normally.
  try {
    const { cellars } = loadSnapshot();
    for (const cellar of cellars) {
      await importCellar(user._id, cellar, {
        targetName: cellar.cellarName,
        mode: 'create',
        demoMode: true,
        getFileBuffer: () => null, // JSON-only: bottles show the shared registry wine image
        defaultCurrency: 'USD',
      });
    }
  } catch (err) {
    console.error('[demoAccount] snapshot clone failed for', String(user._id), '-', err.message);
  }

  return user;
}

// Serialize demo creation so the global-ceiling check and the insert form ONE
// critical section (single backend container). Without this, concurrent demo-
// logins all read the same countDocuments before any insert commits and overshoot
// globalMax (TOCTOU). demo-login is low-volume (per-IP + global caps), so
// serializing costs nothing in practice while making the ceiling actually hold.
let _demoChain = Promise.resolve();
function serializeDemo(fn) {
  const run = _demoChain.then(fn, fn);
  _demoChain = run.then(() => {}, () => {}); // never let a rejection break the chain
  return run;
}

/**
 * Atomically enforce the global live-demo ceiling and create a demo account.
 * Returns the saved User, or null if at/over capacity (demo.globalMax; 0 disables
 * demos entirely). A fast best-effort pre-check sheds obvious over-capacity load
 * without queueing behind the serialized reserve section.
 */
async function createDemoAccountWithinCeiling() {
  const globalMax = rateLimitsConfig.get().demo.globalMax;
  if ((await countLiveDemos()) >= globalMax) return null; // fast path
  return serializeDemo(async () => {
    const live = await countLiveDemos(); // authoritative re-check under the lock
    if (live >= globalMax) return null;
    return createDemoAccount();
  });
}

module.exports = {
  createDemoAccount,
  createDemoAccountWithinCeiling,
  countLiveDemos,
  loadSnapshot,
  SNAPSHOT_PATH,
  DEMO_EMAIL_DOMAIN,
};
