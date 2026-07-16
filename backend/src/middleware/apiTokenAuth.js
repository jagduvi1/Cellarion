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
 * Scopes (docs/ha-push-events.md §3; climate: docs/climate-monitoring.md):
 *   read    — the GETs the Home Assistant integration uses: stats, cellars,
 *             bottles, notifications, the SSE event stream, and /auth/whoami
 *             (its own account id, for reauth same-account verification — id
 *             only, no PII, unlike /auth/me). Also POST /api/mcp: the Model
 *             Context Protocol endpoint, whose per-tool authorization is
 *             enforced inside the MCP registry (a read token sees read tools).
 *   consume — POST /api/bottles/:id/consume only.
 *   climate — POST /api/climate/ingest only: the sensor-device credential.
 *             A leaked device token can post readings and nothing else.
 */
const SCOPE_ALLOWLIST = {
  read: [
    { method: 'GET', pattern: /^\/api\/stats(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/cellars(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/bottles(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/notifications(\/|$)/ },
    { method: 'GET', pattern: /^\/api\/events\/stream$/ },
    // Exact match only — the caller's own account id (id, no PII). Anchored so
    // it can never widen to /api/auth/me or any other /api/auth/* route.
    { method: 'GET', pattern: /^\/api\/auth\/whoami$/ },
    // MCP endpoint (Model Context Protocol). A single POST envelope; which tools
    // the caller may actually invoke is enforced *inside* by the MCP registry's
    // scope filter (a read token only ever sees read/public tools), so reaching
    // this path is safe. Anchored exact — cannot widen to any other /api/mcp/*.
    // GET opens a session's standalone SSE stream (resources/subscribe pushes,
    // plan §4) and DELETE terminates the session — both are no-ops without a
    // live session bound to this exact token (mcp/sessions.js identity check).
    { method: 'POST', pattern: /^\/api\/mcp$/ },
    { method: 'GET', pattern: /^\/api\/mcp$/ },
    { method: 'DELETE', pattern: /^\/api\/mcp$/ },
  ],
  consume: [
    { method: 'POST', pattern: /^\/api\/bottles\/[a-f0-9]{24}\/consume$/ },
    // MCP endpoint — a consume-scoped token may reach it; the registry's scope
    // filter decides which tools it sees (consume + public, not read/write).
    { method: 'POST', pattern: /^\/api\/mcp$/ },
    { method: 'GET', pattern: /^\/api\/mcp$/ },
    { method: 'DELETE', pattern: /^\/api\/mcp$/ },
  ],
  write: [
    // MCP endpoint only — the write scope exists FOR the MCP write tools; it
    // grants no REST routes. Per-tool authz lives in the MCP registry.
    { method: 'POST', pattern: /^\/api\/mcp$/ },
    { method: 'GET', pattern: /^\/api\/mcp$/ },
    { method: 'DELETE', pattern: /^\/api\/mcp$/ },
  ],
  climate: [
    { method: 'POST', pattern: /^\/api\/climate\/ingest$/ },
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

    // An OAuth access token expires (personal PATs have expiresAt === null and
    // never do). A dead access token is a 401 so the MCP client runs its
    // refresh grant — same status as a missing token; the WWW-Authenticate
    // challenge on /api/mcp tells it where to refresh.
    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
      return res.status(401).json({ error: 'Token expired' });
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
