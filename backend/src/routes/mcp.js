const express = require('express');
const router = express.Router();
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { handleMcpRequest } = require('../mcp/server');

// Scopes a caller has when talking to the MCP endpoint. For a personal API token
// (`cel_…`) these are the token's OWN scopes — so a read-only token sees and can
// call only read tools. A JWT session is the user themselves and gets the full
// personal set including `write` (Phase 2b, conscious): the UI already lets a
// logged-in user add/edit/consume, and every mutating tool ships with the
// write-safety stack (registry-safe two-step add, conflict guards, idempotency
// keys, the McpActionLog undo ledger, per-user mutation budget). Demo sessions
// are blocked below; cel_ tokens opt into scopes explicitly at mint time.
const JWT_SCOPES = ['read', 'consume', 'write'];

// POST /api/mcp — stateless Streamable HTTP MCP endpoint. Auth is the same
// requireAuth as the REST API. For `cel_` tokens the SCOPE_ALLOWLIST grants this
// exact path to `read` tokens (middleware/apiTokenAuth.js); a token lacking that
// scope (e.g. a climate device token) is rejected by requireAuth before it ever
// reaches this handler. requireNonDemo keeps ephemeral demo sessions out — MCP is
// a personal-cellar surface reached with your own credentials, and demo accounts
// are shared/throwaway (they also can't mint `cel_` tokens, so this closes the
// only other way in). A `cel_` token never carries isDemo, so requireNonDemo is a
// no-op for it and blocks only demo JWT sessions.
router.post('/', requireAuth, requireNonDemo, async (req, res, next) => {
  try {
    const scopes = req.apiToken ? req.apiToken.scopes : JWT_SCOPES;
    // ctx.req rides along for the mutating tools: logAudit reads actor/ip/UA
    // from it (which also emits the stats_changed SSE nudge), and req.apiToken
    // lets the action ledger attribute the acting token (id only, never the
    // token value).
    await handleMcpRequest(req, res, { user: req.user, scopes, req });
  } catch (err) {
    next(err);
  }
});

// Stateless Streamable HTTP is POST-only; GET is for server→client SSE streams,
// which stateless mode does not open. 405 lets clients fall back cleanly.
router.get('/', requireAuth, requireNonDemo, (req, res) => {
  res.status(405).json({ error: 'MCP endpoint is POST-only (stateless Streamable HTTP)' });
});

module.exports = router;
