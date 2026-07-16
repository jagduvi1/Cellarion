import { JSON_HEADERS } from './apiConstants';

// Recent AI activity (Settings → "What your AI has changed"). Reads the
// McpActionLog ledger for the logged-in user and reverts individual actions.
// JWT-only: these paths live under /api/mcp but are NOT in apiTokenAuth's
// SCOPE_ALLOWLIST, so a `cel_` token cannot read or unwind the ledger — only
// the user's own browser session can. See backend/src/routes/mcp.js.

// GET /api/mcp/activity — { activity: [...], total, revert_window_days }
// Newest first. Each entry: { id, tool, action, summary, cellar_id, bottle_id,
// by ('token'|'session'), reversed, via_undo, revertible, created_at }.
export const getMcpActivity = (apiFetch, { limit = 50, skip = 0 } = {}) =>
  apiFetch(`/api/mcp/activity?limit=${limit}&skip=${skip}`);

// POST /api/mcp/activity/:id/revert — reverse ONE past action via the same
// engine undo_last uses. Returns { reverted: true, summary, data } on success;
// 409 conflict (already reverted / world moved on / too old), 404, 403, 400.
export const revertMcpActivity = (apiFetch, id) =>
  apiFetch(`/api/mcp/activity/${id}/revert`, { method: 'POST', headers: JSON_HEADERS });
