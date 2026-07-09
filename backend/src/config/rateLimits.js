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
  },
  // Per-user burst limit on /api/chat — protects Anthropic budget against
  // scripted abuse from inside a single user's daily-quota allowance. The
  // daily quota (aiConfig.chatDailyLimit) is the cap; this is the speed
  // limit. Default 5 chats/min/user is generous for human use and catches
  // scripted bursts.
  chatBurst: { max: 5, windowMs: 60 * 1000 },
  // Cap concurrent SSE streams per user. Same protection lens as chatBurst:
  // no human reads two AI streams at once; cap is for script abuse.
  chatConcurrentStreams: { max: 2 },
  // Per-user burst limit on Anthropic-backed wine endpoints (/wines/scan-label,
  // /identify-text, /ai-info). Protects Anthropic budget from a scripted loop
  // by any logged-in user. These share one bucket because they share one
  // budget. Vision (scan-label) is the costliest, so 10/min is generous for
  // a human walking through a cellar but still catches scripts.
  aiBurst: { max: 10, windowMs: 60 * 1000 },
  // Shared per-user DAILY budget of actual Anthropic calls across import
  // identify, scan-label, identify-text, ai-info, and user-triggered wine
  // enrichment (SECURITY_AUDIT_2026-07-08 M-2/L-14). aiBurst is the speed
  // limit; this is the spend cap — chat keeps its own separate quota
  // (aiConfig.chatDailyLimit). Sized so a legitimate 2,000-bottle import
  // (~350 AI lookups after dedup + registry-first matching) fits in one day
  // with headroom. 0 = unlimited. Enforced by services/aiBudget.js; when
  // exhausted, imports degrade gracefully to fuzzy matching (never error)
  // and the single-shot AI endpoints return 429 ai_budget_exhausted.
  aiDailyBudget: { max: 500 },
  // Cap on AI identify calls a single POST /api/bottles/import/validate
  // request may fan out (M-2: one request used to mean up to 2,000 Sonnet
  // calls). The frontend validates in batches of 25 items, so legitimate
  // clients never come near this. Excess unique wines in one request fall
  // through to fuzzy matching with aiSkipped: true.
  aiImportPerRequestCap: { max: 50 },
  // Site-wide daily kill-switch: total Anthropic calls per UTC day across all
  // users (tracked as a singleton AiUsage row). Bounds the worst case of many
  // abusive accounts. 0 = disabled. Same graceful degradation as the per-user
  // budget when tripped.
  aiGlobalDailyCap: { max: 20000 },
  // Per-user rolling cap on /api/images/upload. Each upload is up to 10MB and
  // stored on disk; without this cap a logged-in user could script a loop and
  // fill the disk. The per-bottle MAX_IMAGES_PER_BOTTLE cap limits per-resource
  // growth but doesn't stop a user creating bottles + uploading in a loop.
  // Default 30/hour bounds worst-case to ~7 GB/day per user — generous for
  // real use (a session of adding bottles rarely exceeds 30 uploads).
  imageUploadBurst: { max: 30, windowMs: 60 * 60 * 1000 },
};

let cache = {
  api:   { max: defaults.api.max },
  write: { max: defaults.write.max },
  auth:  { max: defaults.auth.max },
  accountLockout: { ...defaults.accountLockout },
  chatBurst: { ...defaults.chatBurst },
  chatConcurrentStreams: { ...defaults.chatConcurrentStreams },
  aiBurst: { ...defaults.aiBurst },
  aiDailyBudget: { ...defaults.aiDailyBudget },
  aiImportPerRequestCap: { ...defaults.aiImportPerRequestCap },
  aiGlobalDailyCap: { ...defaults.aiGlobalDailyCap },
  imageUploadBurst: { ...defaults.imageUploadBurst },
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
        },
        chatBurst: {
          max:      doc.value.chatBurst?.max      ?? defaults.chatBurst.max,
          windowMs: doc.value.chatBurst?.windowMs ?? defaults.chatBurst.windowMs,
        },
        chatConcurrentStreams: {
          max: doc.value.chatConcurrentStreams?.max ?? defaults.chatConcurrentStreams.max,
        },
        aiBurst: {
          max:      doc.value.aiBurst?.max      ?? defaults.aiBurst.max,
          windowMs: doc.value.aiBurst?.windowMs ?? defaults.aiBurst.windowMs,
        },
        aiDailyBudget: {
          max: doc.value.aiDailyBudget?.max ?? defaults.aiDailyBudget.max,
        },
        aiImportPerRequestCap: {
          max: doc.value.aiImportPerRequestCap?.max ?? defaults.aiImportPerRequestCap.max,
        },
        aiGlobalDailyCap: {
          max: doc.value.aiGlobalDailyCap?.max ?? defaults.aiGlobalDailyCap.max,
        },
        imageUploadBurst: {
          max:      doc.value.imageUploadBurst?.max      ?? defaults.imageUploadBurst.max,
          windowMs: doc.value.imageUploadBurst?.windowMs ?? defaults.imageUploadBurst.windowMs,
        },
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
