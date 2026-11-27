const { getClientIp } = require('../utils/clientIp');

/**
 * The attribution a STATEFUL MCP session keeps between requests.
 *
 * A session never holds the live Express request itself. That object carries
 * the parsed JSON body — up to 2 MB under the /api/mcp parser — and a session
 * lives 30 minutes idle / 2 hours absolute, so a full global session cap of
 * them could pin most of the heap: a few dozen throwaway accounts could
 * restart the backend for everyone.
 *
 * services/importPhotos keeps one per import for the same reason: its queue
 * outlives the /confirm request, which carries the whole import body.
 *
 * This snapshot is what every consumer of `ctx.req` actually reads:
 *   - services/audit.js logAudit: user.id, user.roles, getClientIp(req),
 *     headers['user-agent'], cellar (never set on an MCP request);
 *   - mcp/actionLedger.js: apiToken.id;
 *   - mcp/callBudget.js + mutationBudget.js: rateLimitKey(req) → getClientIp;
 *   - the bottle/journal services behind undo: user, ip, headers.
 * `ip` is the CLIENT ip already resolved through the Cloudflare rule, and
 * no cf-connecting-ip header is carried, so getClientIp(snapshot) returns
 * it unchanged. Nothing else — in particular no body, params or query.
 */
function snapshotRequest(req) {
  if (!req) return req;
  return {
    user: req.user,
    apiToken: req.apiToken ? { id: req.apiToken.id, scopes: req.apiToken.scopes } : undefined,
    ip: getClientIp(req),
    headers: { 'user-agent': req.headers ? req.headers['user-agent'] : undefined },
  };
}

module.exports = { snapshotRequest };
