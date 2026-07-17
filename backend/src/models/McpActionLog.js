const mongoose = require('mongoose');

/**
 * McpActionLog — the write-safety ledger for MCP mutations (plan §5.3/§5.7 L4).
 *
 * One row per mutating MCP tool call. Powers three things:
 *  1. Idempotency: a retrying/looping agent that resends the same
 *     idempotency_key gets the ORIGINAL result back instead of acting twice.
 *  2. undo_last: the newest un-reversed action is what "undo" undoes; `prev`
 *     snapshots whatever the reverse operation needs (e.g. the consumed-*
 *     fields so undoing a restore can re-consume identically).
 *  3. The "recent AI activity" timeline (frontend, Phase 2d) — what did my
 *     connected AI change, with one-click revert.
 *
 * Retention: 90 days (TTL below) — matches AuditLog's default; undo itself is
 * bounded much tighter by the bottle restore window. GDPR: registered in
 * services/userDataRegistry.js (export + purge on account deletion).
 */
const mcpActionLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The cel_ token that performed the action; null when a logged-in session
  // (JWT) called the MCP directly. Never store the token itself.
  tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiToken', default: null },
  tool: { type: String, required: true },
  action: { type: String, enum: ['consume', 'restore', 'add', 'update', 'undo_add', 'bulk_preview', 'bulk_add', 'somm_maturity', 'somm_price', 'cellar_create', 'rack_create', 'place', 'unplace', 'move', 'arrange_preview', 'arrange', 'tasting_note', 'attach_image'], required: true },
  bottle: { type: mongoose.Schema.Types.ObjectId, ref: 'Bottle' },
  cellar: { type: mongoose.Schema.Types.ObjectId, ref: 'Cellar' },
  // Small, non-PII operational detail (reason, ml, …) for the timeline.
  detail: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Snapshot needed to REVERSE this action (e.g. consumed-* fields).
  prev: { type: mongoose.Schema.Types.Mixed, default: null },
  // Client-supplied replay guard; unique per user when present.
  idempotencyKey: { type: String, default: null },
  // The ok()-envelope body originally returned — replayed verbatim on an
  // idempotent retry so the caller can't tell the difference.
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  // Set once undo_last (or a manual revert) has reversed this action.
  reversed: { type: Boolean, default: false },
  // True on rows created BY undo_last (the record of a reversal). Excluded
  // from undo candidacy so sequential undos walk backward through the user's
  // own actions instead of ping-ponging on one.
  viaUndo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

mcpActionLogSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
mcpActionLogSchema.index({ user: 1, createdAt: -1 });
// TTL — single index on createdAt, no competing plain index (IndexOptionsConflict
// silently disables TTL otherwise; see models/AuditLog.js).
mcpActionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('McpActionLog', mcpActionLogSchema);
