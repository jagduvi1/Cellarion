/**
 * MCP undo-snapshot retention — runs hourly via the scheduler.
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
 * The same holds for a declined price-tracking request (reject_price_request):
 * its `prev` lists the members who asked for the pair, with the note each
 * wrote, so that undo_last can put the request back. Every undo is bounded by
 * the same window (mcp/revert.js revertLatest, routes/mcp.js), so past it the
 * list is other members' data kept for nothing.
 *
 * Hourly, so a snapshot outlives its window by at most an hour. Account
 * erasure purges the rows outright regardless (userDataRegistry).
 */
const McpActionLog = require('../models/McpActionLog');
const { RESTORE_WINDOW_MS } = require('./bottleOps');

/** The ledger actions whose `prev` holds personal data that only an undo reads. */
const SCRUBBED_ACTIONS = ['delete', 'somm_price_decline'];

async function runMcpSnapshotScrub() {
  const cutoff = new Date(Date.now() - RESTORE_WINDOW_MS);
  const result = await McpActionLog.updateMany(
    { action: { $in: SCRUBBED_ACTIONS }, createdAt: { $lt: cutoff }, prev: { $ne: null } },
    { $set: { prev: null } }
  );
  const scrubbed = result.modifiedCount || 0;
  if (scrubbed > 0) {
    console.log(`[mcpSnapshotRetention] Cleared ${scrubbed} undo snapshot(s) past the undo window`);
  }
  return { scrubbed };
}

module.exports = { runMcpSnapshotScrub, SCRUBBED_ACTIONS };
