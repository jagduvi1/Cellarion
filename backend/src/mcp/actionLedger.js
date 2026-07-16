// Shared ledger helpers for MUTATING MCP tools (consume.js, write.js):
// idempotency replay + the McpActionLog row every mutation records for
// undo_last / the activity timeline. See models/McpActionLog.js.
const McpActionLog = require('../models/McpActionLog');

/** Persist the action ledger row. Never throws (the action itself succeeded). */
async function logAction(ctx, entry) {
  try {
    return await McpActionLog.create({
      user: ctx.user.id,
      tokenId: ctx.req?.apiToken?.id || null,
      ...entry,
    });
  } catch (err) {
    // Duplicate idempotencyKey race: the concurrent twin already recorded it.
    if (err?.code !== 11000) console.error('[mcp] action log failed:', err.message);
    return null;
  }
}

/**
 * Idempotent replay: return the stored envelope for a seen key, else null.
 * Reversed actions don't replay — if the action was undone since, a retry
 * should go through the normal path (and re-assert) rather than reporting a
 * stale success for a state that no longer holds.
 */
async function replay(ctx, idempotencyKey) {
  if (!idempotencyKey) return null;
  const seen = await McpActionLog.findOne({ user: ctx.user.id, idempotencyKey, reversed: false }).lean();
  return seen?.result ? { content: [{ type: 'text', text: JSON.stringify(seen.result) }] } : null;
}

module.exports = { logAction, replay };
