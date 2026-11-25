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
  // Per-user burst limit on Anthropic-backed wine endpoints (/wines/scan-label,
  // /identify-text, /ai-info). Protects Anthropic budget from a scripted loop
  // by any logged-in user. These share one bucket because they share one
  // budget. Vision (scan-label) is the costliest, so 10/min is generous for
  // a human walking through a cellar but still catches scripts.
  aiBurst: { max: 10, windowMs: 60 * 1000 },
  // Shared per-user DAILY budget of actual Anthropic calls across import
  // identify, scan-label, identify-text, ai-info, and user-triggered wine
  // enrichment. aiBurst is the speed limit; this is the spend cap — chat keeps
  // its own separate quota (aiConfig.chatDailyLimit). Sized so a legitimate
  // 2,000-bottle import (~350 AI lookups after dedup + registry-first
  // matching) fits in one day with headroom. 0 = unlimited. Enforced by
  // services/aiBudget.js; when exhausted, imports degrade gracefully to fuzzy
  // matching (never error) and the single-shot AI endpoints return 429
  // ai_budget_exhausted.
  aiDailyBudget: { max: 500 },
  // Cap on AI identify calls a single POST /api/bottles/import/validate
  // request may fan out — without it, one request could mean up to 2,000 AI
  // calls. The frontend validates in batches of 25 items, so legitimate
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
  // 60/hour leaves room for the most engaged first-day behaviour — a new
  // member photographing their whole cellar in one sitting — which a tighter
  // cap blocks again and again. Worst-case disk bound is ~14 GB/day per user,
  // still sweepable and tunable below.
  imageUploadBurst: { max: 60, windowMs: 60 * 60 * 1000 },
  // ANONYMOUS registry reads: GET /api/wines/:idOrSlug/public, the only wine
  // endpoint that needs no account. It exists so wine pages are public and
  // indexable, which is worth keeping — but under the general /api/ limiter
  // alone, one address could walk the whole registry quickly.
  //
  // Search crawlers never read it: nginx serves them the server-rendered page
  // (routes/og), so a tight cap costs nothing in indexing. 120 per 15 minutes
  // is a wine page every 7.5 seconds sustained, far beyond any human session,
  // while a single-address scrape of the full registry takes many hours.
  //
  // This does NOT stop a determined actor spreading across many addresses;
  // nothing that also serves public pages can. It makes casual scraping not
  // worth the trouble, which is the achievable goal.
  publicWineRead: { max: 120, windowMs: 15 * 60 * 1000 },
  // Registry lockdown: DISTINCT wines per reader per UTC day. Limiters count
  // requests in a window and cannot tell a person browsing from a copier; this
  // can. Anonymous addresses over the cap are refused for the rest of the day
  // on the public wine endpoint and the anonymous MCP; members are never
  // refused, only listed in the daily readers report when they pass the alert
  // level. Sized far above real use (a few public reads per address per day)
  // and far below any useful copy of the registry.
  registryRead: { anonymousDailyDistinct: 300, memberAlertDistinct: 1000 },
  // Registry Bridge: what one self-hosted install may do with the shared
  // registry per key per UTC day, and its per-minute burst. Generous for a
  // household, tight for a copier: a full copy at 300 fetches a day takes
  // weeks and is reported every day of it. The owner's monthly import window
  // multiplies the four daily caps by five; services/bridgeQuota.js and
  // routes/bridgeV1.js read this group per request.
  // `enabled: 0` closes the whole /api/bridge/v1 protocol with a 503 — the
  // same kill switch the MCP surface has. Key management and the self-hosted
  // client's own Settings card stay up; only registry access stops.
  bridge: { enabled: 1, searches: 600, fetches: 300, changeChecks: 1, contributions: 50, burstPerMinute: 60 },
  // Ephemeral public-demo accounts (POST /api/auth/demo-login). Cloning a
  // snapshot cellar per visitor is write-heavy, so this is bounded on three
  // axes: per-IP creation rate, a DURABLE global ceiling on concurrent live
  // demos (the real backstop — it survives restarts, unlike the in-memory
  // per-IP limiter), and a short account lifetime the demoSweepJob enforces.
  // Conservative defaults sized for a 4 GB VM: ~100 live demos × a small
  // snapshot. All runtime-tunable by SuperAdmin.
  demo: {
    createMax:      3,                  // demo creations per IP per window
    createWindowMs: 60 * 60 * 1000,     // 1 hour
    globalMax:      100,                // max concurrent live demo accounts
    ttlMs:          2 * 60 * 60 * 1000, // demo account lifetime (2 hours)
  },
  // MCP kill switches (0/1 booleans, same runtime-tunable machinery as the
  // demo and AI kill-switches above). `enabled: 0` shuts the WHOLE AI surface
  // (personal /api/mcp AND anonymous /api/mcp/public) with a clear 503;
  // `publicEnabled: 0` shuts only the anonymous endpoint. The browser-facing
  // routes under /api/mcp (activity timeline, revert, export-link download)
  // stay up either way — the switch cuts AI protocol access, not the human's
  // review tools. Checked per request from this in-memory cache: zero DB cost.
  //
  // Protocol-endpoint rate limits: hosted AI connectors (claude.ai, ChatGPT)
  // egress from a SMALL shared IP pool, so under the global per-IP apiLimiter
  // every hosted user would share one 15-minute bucket. The personal endpoint
  // instead runs its own two-layer limit (routes/mcp.js):
  //   userMax — fair-share ceiling per 15 min, keyed by the AUTHENTICATED
  //             user id (one chatty agent can only starve itself);
  //   ipMax   — pre-auth per-IP flood/credential-probe guard, sized for many
  //             users behind one shared egress IP (fairness is userMax's job).
  //   registerMax — Dynamic Client Registration (RFC 7591) per IP per HOUR.
  //             Same shared-egress problem, one step earlier: every NEW
  //             connection from a hosted platform registers a client first, and
  //             they all arrive from that platform's egress pool, so a tight
  //             cap gives the next person to connect that hour a 429 with no
  //             way to diagnose it. It still has to stay bounded (each call
  //             persists an OAuthClient row), and it is tunable without a
  //             deploy.
  //   oauthMax — per-IP ceiling per 15 min across the REST of the OAuth
  //             authorization server (/authorize, /approve, /token, /revoke).
  //             Those four are exempt from the global apiLimiter/writeLimiter
  //             for the shared-egress reason above, and nginx carries no
  //             limit_req, so without this a self-hosted instance would have
  //             no bound on them at all. A ceiling that EXISTS without being
  //             a tight one: sized so a whole platform's user base can
  //             refresh hourly from one egress IP and never see it.
  //             registerMax stays separate — DCR persists a row per call and
  //             needs the stricter, per-HOUR bound.
  mcp: { enabled: 1, publicEnabled: 1, userMax: 300, ipMax: 5000, registerMax: 200, oauthMax: 2000 },
};

let cache = {
  api:   { max: defaults.api.max },
  write: { max: defaults.write.max },
  auth:  { max: defaults.auth.max },
  accountLockout: { ...defaults.accountLockout },
  chatBurst: { ...defaults.chatBurst },
  aiBurst: { ...defaults.aiBurst },
  aiDailyBudget: { ...defaults.aiDailyBudget },
  aiImportPerRequestCap: { ...defaults.aiImportPerRequestCap },
  aiGlobalDailyCap: { ...defaults.aiGlobalDailyCap },
  imageUploadBurst: { ...defaults.imageUploadBurst },
  publicWineRead: { ...defaults.publicWineRead },
  registryRead: { ...defaults.registryRead },
  bridge: { ...defaults.bridge },
  demo: { ...defaults.demo },
  mcp: { ...defaults.mcp },
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

        publicWineRead: {
          max:      doc.value.publicWineRead?.max      ?? defaults.publicWineRead.max,
          windowMs: doc.value.publicWineRead?.windowMs ?? defaults.publicWineRead.windowMs,

        },
        registryRead: {
          anonymousDailyDistinct: doc.value.registryRead?.anonymousDailyDistinct ?? defaults.registryRead.anonymousDailyDistinct,
          memberAlertDistinct:    doc.value.registryRead?.memberAlertDistinct    ?? defaults.registryRead.memberAlertDistinct,
        },
        bridge: {
          enabled:        doc.value.bridge?.enabled        ?? defaults.bridge.enabled,
          searches:       doc.value.bridge?.searches       ?? defaults.bridge.searches,
          fetches:        doc.value.bridge?.fetches        ?? defaults.bridge.fetches,
          changeChecks:   doc.value.bridge?.changeChecks   ?? defaults.bridge.changeChecks,
          contributions:  doc.value.bridge?.contributions  ?? defaults.bridge.contributions,
          burstPerMinute: doc.value.bridge?.burstPerMinute ?? defaults.bridge.burstPerMinute,
        },
        demo: {
          createMax:      doc.value.demo?.createMax      ?? defaults.demo.createMax,
          createWindowMs: doc.value.demo?.createWindowMs ?? defaults.demo.createWindowMs,
          globalMax:      doc.value.demo?.globalMax      ?? defaults.demo.globalMax,
          ttlMs:          doc.value.demo?.ttlMs          ?? defaults.demo.ttlMs,
        },
        mcp: {
          enabled:       doc.value.mcp?.enabled       ?? defaults.mcp.enabled,
          publicEnabled: doc.value.mcp?.publicEnabled ?? defaults.mcp.publicEnabled,
          userMax:       doc.value.mcp?.userMax       ?? defaults.mcp.userMax,
          ipMax:         doc.value.mcp?.ipMax         ?? defaults.mcp.ipMax,
          registerMax:   doc.value.mcp?.registerMax   ?? defaults.mcp.registerMax,
          oauthMax:      doc.value.mcp?.oauthMax      ?? defaults.mcp.oauthMax,
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
