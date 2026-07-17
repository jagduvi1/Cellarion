// Shared ledger helpers for MUTATING MCP tools (consume.js, write.js, …):
// idempotency claim/replay + the McpActionLog row every mutation records for
// undo_last / the activity timeline. See models/McpActionLog.js.
//
// Concurrency contract (prior-audit M2): the idempotency decision is an ATOMIC
// CLAIM, not a read. replay() upserts a `pending` stub row on the unique
// {user, idempotencyKey} index BEFORE the caller mutates — of two concurrent
// same-key twins exactly one wins the insert; the loser gets the stored result
// (replay) or an in-progress conflict, and never reaches the mutation. The old
// shape (findOne → mutate → create, duplicate-key swallowed) let both twins
// mutate and only deduplicated the ledger row afterwards.
const McpActionLog = require('../models/McpActionLog');

// A pending claim older than this is considered crashed (the process died
// between claim and logAction) and may be re-claimed by a retry. Well above
// any real tool-call duration (MCP requests are bounded to seconds); failures
// that RETURN normally release their claim immediately via releaseClaim.
const CLAIM_STALE_MS = 2 * 60 * 1000;

// `idempotencyBusy` tells the server's release-on-error wrapper that this
// error DOESN'T mean "my claim failed" — a concurrent twin owns the key and
// its live pending claim must not be deleted out from under it.
const inProgress = () => ({
  isError: true,
  idempotencyBusy: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code: 'conflict', message: 'An identical request (same idempotency_key) is already in progress — wait a moment; if it succeeded, retrying returns its result.' } }) }],
});

const replayEnvelope = (row) =>
  row?.result ? { content: [{ type: 'text', text: JSON.stringify(row.result) }] } : inProgress();

/**
 * Persist the action ledger row. Never throws (the action itself succeeded).
 * With an idempotencyKey this COMPLETES the pending claim replay() took
 * (overwrites the stub in place — same _id, unique index untouched); without
 * one it creates a plain row as before.
 */
async function logAction(ctx, entry) {
  try {
    if (entry.idempotencyKey) {
      return await McpActionLog.findOneAndUpdate(
        { user: ctx.user.id, idempotencyKey: entry.idempotencyKey, pending: true },
        {
          $set: {
            tokenId: ctx.req?.apiToken?.id || null,
            ...entry,
            pending: false,
            createdAt: new Date(), // completion time, not claim time (undo window)
          },
        },
        { new: true }
      );
    }
    return await McpActionLog.create({
      user: ctx.user.id,
      tokenId: ctx.req?.apiToken?.id || null,
      ...entry,
    });
  } catch (err) {
    console.error('[mcp] action log failed:', err.message);
    return null;
  }
}

/**
 * Atomic idempotency claim. Returns null when this call now OWNS the key and
 * must proceed to mutate (then logAction completes the claim, or the server
 * releases it on error). Returns a ready-to-return envelope otherwise:
 * the original result for a completed key, or an in-progress conflict while
 * a concurrent twin is still mid-flight.
 *
 * Reversed rows don't block: every revert path nulls idempotencyKey on the
 * row it reverses, freeing the key so a retry re-executes (and re-records).
 */
async function replay(ctx, idempotencyKey) {
  if (!idempotencyKey) return null;
  const stub = {
    user: ctx.user.id,
    tokenId: ctx.req?.apiToken?.id || null,
    tool: 'pending',
    action: 'pending',
    idempotencyKey,
    pending: true,
    createdAt: new Date(),
  };
  let existing;
  try {
    const res = await McpActionLog.findOneAndUpdate(
      { user: ctx.user.id, idempotencyKey },
      { $setOnInsert: stub },
      { upsert: true, new: false, includeResultMetadata: true }
    );
    // Upsert inserted (or the model is a unit-test mock with no metadata) →
    // we own the claim.
    if (!res?.lastErrorObject?.updatedExisting) return null;
    existing = res.value;
  } catch (err) {
    // Two concurrent upserts for a not-yet-existing key can BOTH take the
    // insert path; the unique index fails the loser with E11000. The winner
    // owns the claim — re-read the row and fall through to the branches below.
    if (err?.code !== 11000) throw err;
    existing = await McpActionLog.findOne({ user: ctx.user.id, idempotencyKey }).lean();
    if (!existing) return inProgress(); // deleted in the same instant — treat as busy, retry works
  }

  if (!existing.pending) return replayEnvelope(existing); // completed → replay
  // Pending: a twin is mid-flight — unless it crashed long enough ago that the
  // claim is stale, in which case take it over atomically (one taker wins).
  const claimedAt = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
  if (Date.now() - claimedAt > CLAIM_STALE_MS) {
    const stolen = await McpActionLog.findOneAndUpdate(
      { _id: existing._id, pending: true, createdAt: existing.createdAt },
      { $set: { createdAt: new Date(), tokenId: ctx.req?.apiToken?.id || null } }
    );
    if (stolen) return null; // we own the (re-)claim
  }
  return inProgress();
}

/**
 * Drop an UNCOMPLETED claim so the key is immediately reusable — called by the
 * server wrapper when a tool call that carried an idempotency_key returns an
 * error (the mutation did not commit; logAction was never reached). A completed
 * row has pending:false and is never touched. Never throws.
 */
async function releaseClaim(ctx, idempotencyKey) {
  if (!idempotencyKey || !ctx?.user?.id) return;
  try {
    await McpActionLog.deleteOne({ user: ctx.user.id, idempotencyKey, pending: true });
  } catch { /* best-effort; a leftover stub goes stale-reclaimable, then TTL */ }
}

module.exports = { logAction, replay, releaseClaim, CLAIM_STALE_MS };
