const express = require('express');
const router = express.Router();
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { handleMcpRequest } = require('../mcp/server');
const mongoose = require('mongoose');
const McpActionLog = require('../models/McpActionLog');
const { RESTORE_WINDOW_MS } = require('../services/bottleOps');
const { revertLedgerRow, reversibleActionsFor } = require('../mcp/revert');

// The action types a browser session can reverse (full personal authority =
// consume + write). Excludes bulk_preview (changed nothing) and undo_add / other
// viaUndo records — so a "preview then declined" row never shows a Revert button.
const REVERSIBLE_ACTIONS = new Set(reversibleActionsFor(['consume', 'write']));

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

// ── Recent AI activity timeline (Phase 2d) ──────────────────────────────────
// The in-app view of what a connected AI changed, with one-click revert. These
// routes are JWT-ONLY: they live under /api/mcp but are NOT in apiTokenAuth's
// SCOPE_ALLOWLIST, so a `cel_` token (which can reach POST /api/mcp) is rejected
// by requireAuth before arriving here. A user reviews/reverts their OWN AI
// activity from their OWN logged-in session — an AI token cannot inspect or
// unwind the ledger, only append to it.

// A row is user-revertible from the browser while it is a reversible action
// type, is un-reversed, is not itself an undo record, and is still inside the
// reversal window (older rows show as history only — the underlying bottle
// window has lapsed anyway). A bulk_preview that was never applied changed
// nothing, so it is never revertible (and never shown — see the query below).
function isRevertible(row) {
  return REVERSIBLE_ACTIONS.has(row.action) && !row.reversed && !row.viaUndo &&
    row.createdAt.getTime() >= Date.now() - RESTORE_WINDOW_MS;
}

// Timeline shape — deliberately minimal and non-PII: the human-readable summary
// is the one already stored in the action's result envelope.
function toTimelineEntry(row) {
  return {
    id: String(row._id),
    tool: row.tool,
    action: row.action,
    summary: (row.result && row.result.summary) || `${row.tool} (${row.action})`,
    cellar_id: row.cellar ? String(row.cellar) : null,
    bottle_id: row.bottle ? String(row.bottle) : null,
    by: row.tokenId ? 'token' : 'session',
    reversed: !!row.reversed,
    via_undo: !!row.viaUndo,
    revertible: isRevertible(row),
    created_at: row.createdAt,
  };
}

// GET /api/mcp/activity — the caller's MCP action ledger, newest first.
router.get('/activity', requireAuth, requireNonDemo, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    // Hide bulk_preview rows: a preview that was shown-then-declined changed
    // nothing, so surfacing it as "AI activity" is misleading (and it can never
    // be reverted). Applied bulk adds land as a separate `bulk_add` row.
    const filter = { user: req.user.id, action: { $ne: 'bulk_preview' } };
    const [rows, total] = await Promise.all([
      McpActionLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      McpActionLog.countDocuments(filter),
    ]);
    res.json({
      activity: rows.map(toTimelineEntry),
      total,
      // Tells the UI how long revert stays available, without hard-coding it there.
      revert_window_days: Math.round(RESTORE_WINDOW_MS / 86400000),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp/activity/:id/revert — reverse ONE specific past action. Shares
// the exact reversal engine undo_last uses (mcp/revert.js), so a browser revert
// and an AI's "undo that" can never diverge. Ownership, un-reversed state, the
// not-an-undo-record rule and the window are all re-checked here before the
// engine (which re-verifies world state and claims the row atomically) runs.
router.post('/activity/:id/revert', requireAuth, requireNonDemo, async (req, res, next) => {
  try {
    // A non-ObjectId :id would throw a Mongoose CastError (→ 500); treat it as
    // simply not found, like any other id that isn't the caller's.
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'No such AI action on your account.' });
    }
    const row = await McpActionLog.findOne({ _id: req.params.id, user: req.user.id });
    if (!row) return res.status(404).json({ error: 'No such AI action on your account.' });
    if (row.reversed) return res.status(409).json({ error: 'That action has already been reverted.' });
    if (row.viaUndo) return res.status(400).json({ error: 'That entry is itself a revert and cannot be reverted.' });
    if (!isRevertible(row)) {
      return res.status(409).json({ error: 'That action is too old to revert automatically. Adjust the bottle in your cellar directly.' });
    }
    // A logged-in session acts as the user with their full personal authority,
    // so every action class is reversible; the engine still re-checks per-bottle
    // access and somm role before touching anything.
    const ctx = { user: req.user, scopes: ['read', 'consume', 'write'], req };
    const result = await revertLedgerRow(row, ctx, {
      ok: (summary, data) => ({ ok: true, summary, data }),
      fail: (code, message) => ({ ok: false, code, message }),
    });
    if (!result.ok) {
      const status = { conflict: 409, not_found: 404, forbidden_scope: 403, invalid_input: 400 }[result.code] || 400;
      return res.status(status).json({ error: result.message, code: result.code });
    }
    res.json({ reverted: true, summary: result.summary, data: result.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
