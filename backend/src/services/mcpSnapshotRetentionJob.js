/**
 * MCP delete-snapshot retention — runs hourly via the scheduler.
 *
 * delete_bottle keeps the deleted bottle's full document (notes, purchase,
 * reservation names, a withdrawn import request) in its McpActionLog row's
 * `prev`, because that is what undo_last restores it from. The undo only
 * works inside RESTORE_WINDOW_MS (services/bottleOps), and the ledger row
 * itself lives 90 days (its TTL index) for the activity timeline. A snapshot
 * that can no longer be used is personal data kept for nothing (GDPR data
 * minimisation, storage limitation), so once the window has passed this job
 * clears `prev` and leaves the row — the timeline line "deleted bottle X"
 * stays; the bottle's contents do not.
 *
 * Hourly, so a snapshot outlives its window by at most an hour. Account
 * erasure purges the rows outright regardless (userDataRegistry).
 */
const McpActionLog = require('../models/McpActionLog');
const { RESTORE_WINDOW_MS } = require('./bottleOps');

async function runMcpSnapshotScrub() {
  const cutoff = new Date(Date.now() - RESTORE_WINDOW_MS);
  const result = await McpActionLog.updateMany(
    { action: 'delete', createdAt: { $lt: cutoff }, prev: { $ne: null } },
    { $set: { prev: null } }
  );
  const scrubbed = result.modifiedCount || 0;
  if (scrubbed > 0) {
    console.log(`[mcpSnapshotRetention] Cleared ${scrubbed} delete snapshot(s) past the undo window`);
  }
  return { scrubbed };
}

module.exports = { runMcpSnapshotScrub };
