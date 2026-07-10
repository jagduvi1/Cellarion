const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const { logAudit } = require('../services/audit');

const { TOKEN_PREFIX } = ApiToken;

// How often lastUsedAt is persisted (and token.used audited) per token. Keeps
// a polling integration from turning every authenticated request into a write.
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Scope → route allowlist. DEFAULT-DENY: an API token is accepted ONLY on the
 * method+path combinations listed for one of its scopes; every other request
 * is rejected with 403 regardless of what middleware the route itself carries.
 *
 * This is deliberately centralized here instead of per-route requireScope()
 * calls: with scattered opt-in checks, any route that forgot the check would
 * silently accept a scoped token as full auth (e.g. a leaked "read-only" token
 * could hit DELETE /api/users/me or GET /api/users/me/export). With the
 * allowlist, new routes are unreachable by tokens until explicitly added.
 *
 * Paths are matched against the decoded path Express routes on
 * (req.baseUrl + req.path), not req.originalUrl, so query strings and
 * percent-encoding cannot influence matching.
 *
 * Scopes (docs/ha-push-events.md §3):
 *   read    — the GETs the Home Assistant integration uses: stats, cellars,
 *             bottles, notifications, and the SSE event stream.
 *   consume — POST /api/bottles/:id/consume only.
 */
const SCOPE_ALLOWLIST = {
  read: [
    { method: 'GET', pattern: /^\/api\/stats(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/cellars(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/bottles(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/notifications(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/events\/stream$/ },
  ],
  consume: [
    { method: 'POST', pattern: /^\/api\/bottles\/[a-f0-9]{24}\/consume$/ },
  ],
};

/**
 * Endpoints under the allowed prefixes that tokens must NOT reach, checked
 * before the scope rules. The read prefixes cover the wine-data GETs the HA
 * integration uses, but three sub-paths under them carry a different class of
 * data than "the caller's wine data":
 *   - /api/cellars/:id/audit    — audit log incl. collaborator IPs and emails
 *   - /api/cellars/:id/members  — collaborator emails
 *   - /api/bottles/import/*     — the import subsystem (a separate router
 *                                 mounted under the /api/bottles prefix)
 * When adding a new sub-route under /api/cellars or /api/bottles, ask whether
 * it returns anything beyond the caller's own wine data — if so, add it here.
 */
const TOKEN_EXCLUSIONS = [
  /^\/api\/cellars\/[^/]+\/audit(\/|$)/,
  /^\/api\/cellars\/[^/]+\/members(\/|$)/,
  /^\/api\/bottles\/import(\/|$)/,
];

/** True when the bearer credential is a personal API token, not a JWT. */
function isApiTokenCredential(credential) {
  return typeof credential === 'string' && credential.startsWith(TOKEN_PREFIX);
}

/** Default-deny scope check. Exported for direct unit testing. */
function isRequestAllowed(scopes, method, path) {
  // Normalize: Express treats HEAD as GET, and a trailing slash as the same route.
  const m = method === 'HEAD' ? 'GET' : method;
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (TOKEN_EXCLUSIONS.some(rule => rule.test(p))) return false;
  for (const scope of scopes || []) {
    for (const rule of SCOPE_ALLOWLIST[scope] || []) {
      if (rule.method === m && rule.pattern.test(p)) return true;
    }
  }
  return false;
}

/**
 * Authenticate a `cel_...` bearer credential. Called by requireAuth when the
 * credential carries the API-token prefix; sends the error response itself on
 * failure, calls next() with req.user + req.apiToken attached on success.
 */
async function authenticateApiToken(req, res, next, rawToken) {
  try {
    const tokenHash = ApiToken.hashToken(rawToken);
    const token = await ApiToken.findOne({ tokenHash, revokedAt: null });
    if (!token) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await User.findById(token.user)
      .select('roles plan planExpiresAt deletionScheduledFor');
    // A token whose account is gone or pending deletion is dead — same policy
    // as refresh sessions, which are revoked when deletion is requested.
    if (!user || user.deletionScheduledFor) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const path = (req.baseUrl || '') + (req.path || '');
    if (!isRequestAllowed(token.scopes, req.method, path)) {
      return res.status(403).json({ error: 'API token scope insufficient for this request' });
    }

    // Same effective-plan downgrade as the JWT path in requireAuth.
    const planExpired = user.planExpiresAt && Date.now() > user.planExpiresAt.getTime();
    req.user = {
      id: user._id.toString(),
      roles: user.roles && user.roles.length > 0 ? user.roles : ['user'],
      plan: planExpired ? 'free' : (user.plan || 'free'),
      planExpiresAt: user.planExpiresAt || null,
    };
    req.apiToken = { id: token._id.toString(), scopes: token.scopes };

    // Throttled usage bookkeeping — fire-and-forget, never blocks the request.
    if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
      ApiToken.updateOne({ _id: token._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
      // Audit the token id, never the token itself.
      logAudit(req, 'token.used', { type: 'apiToken', id: token._id }, {});
    }

    next();
  } catch (error) {
    console.error('API token auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

module.exports = {
  isApiTokenCredential,
  authenticateApiToken,
  isRequestAllowed,
  SCOPE_ALLOWLIST,
  TOKEN_EXCLUSIONS,
  LAST_USED_THROTTLE_MS,
};
