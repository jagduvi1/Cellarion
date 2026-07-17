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
//
// Idempotency keys are scoped PER TOOL (MCP-audit M2): the stub records the
// claiming tool, and a key seen on a DIFFERENT tool is refused (invalid_input)
// rather than replaying the first tool's result — so an agent that recycles one
// key across `update_bottle` then `add_bottle` can't be told the add "succeeded"
// with the update's envelope.
const McpActionLog = require('../models/McpActionLog');

// A pending claim older than this is considered crashed (the process died
// between claim and logAction) and may be re-claimed by a retry. Well above
// any real tool-call duration (MCP requests are bounded to seconds); failures
// that RETURN normally release their claim immediately via releaseClaim.
const CLAIM_STALE_MS = 2 * 60 * 1000;

// `idempotencyBusy` tells the server's release-on-error wrapper that this
// error DOESN'T mean "my claim failed" — a concurrent twin owns the key and
// its live pending claim must not be deleted out from under it. The `busy`
// code (distinct from `conflict`, MCP-audit M1) tells the CLIENT this is
// transient: retry the SAME idempotency_key shortly, don't rotate it (rotating
// would bypass the claim and double-execute).
const inProgress = () => ({
  isError: true,
  idempotencyBusy: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code: 'busy', message: 'An identical request (same idempotency_key) is already in progress — retry the SAME idempotency_key in a moment; if it succeeded, the retry returns its result. Do not generate a new key.' } }) }],
});

// A key already used by a DIFFERENT tool. Not retryable with this key — the
// client must use a fresh key for the new operation (MCP-audit M2).
const crossToolConflict = (otherTool) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code: 'invalid_input', message: `That idempotency_key was already used for a different tool (${otherTool}). Use a fresh idempotency_key per distinct operation.` } }) }],
});

const replayEnvelope = (row) =>
  row?.result ? { content: [{ type: 'text', text: JSON.stringify(row.result) }] } : inProgress();

/**
 * Persist the action ledger row. Never throws (the action itself succeeded).
 * With an idempotencyKey this COMPLETES the pending claim replay() took
 * (overwrites the stub in place — same _id, unique index untouched); without
 * one it creates a plain row as before. The completion filter includes `tool`
 * so it can only ever land on THIS tool's own claim stub.
 */
async function logAction(ctx, entry) {
  try {
    if (entry.idempotencyKey) {
      return await McpActionLog.findOneAndUpdate(
        { user: ctx.user.id, tool: entry.tool, idempotencyKey: entry.idempotencyKey, pending: true },
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
 * Atomic idempotency claim for `toolName`. Returns null when this call now OWNS
 * the key and must proceed to mutate (then logAction completes the claim, or the
 * server releases it on error). Otherwise returns a ready-to-return envelope:
 * the original result for a completed same-tool key (`replay`), an in-progress
 * `busy` conflict while a same-tool twin is mid-flight, or an `invalid_input`
 * when the key belongs to a DIFFERENT tool.
 *
 * Reversed rows don't block: every revert path nulls idempotencyKey on the
 * row it reverses, freeing the key so a retry re-executes (and re-records).
 */
async function replay(ctx, idempotencyKey, toolName) {
  if (!idempotencyKey) return null;
  const stub = {
    user: ctx.user.id,
    tokenId: ctx.req?.apiToken?.id || null,
    tool: toolName || 'pending',
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

  // Cross-tool reuse guard (M2): the key belongs to another tool — refuse
  // BEFORE any replay/steal so we never return the wrong tool's result and
  // never steal a different tool's live claim. Legacy stubs (tool:'pending')
  // predate per-tool scoping and fall through to the stale-steal path.
  if (toolName && existing.tool && existing.tool !== 'pending' && existing.tool !== toolName) {
    return crossToolConflict(existing.tool);
  }

  if (!existing.pending) return replayEnvelope(existing); // completed (same tool) → replay
  // Pending: a same-tool twin is mid-flight — unless it crashed long enough ago
  // that the claim is stale, in which case take it over atomically (one wins).
  const claimedAt = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
  if (Date.now() - claimedAt > CLAIM_STALE_MS) {
    const stolen = await McpActionLog.findOneAndUpdate(
      { _id: existing._id, pending: true, createdAt: existing.createdAt },
      { $set: { createdAt: new Date(), tool: toolName || existing.tool, tokenId: ctx.req?.apiToken?.id || null } }
    );
    if (stolen) return null; // we own the (re-)claim
  }
  return inProgress();
}

/**
 * Drop an UNCOMPLETED claim so the key is immediately reusable — called by the
 * server wrapper when a tool call that carried an idempotency_key returns an
 * error (the mutation did not commit; logAction was never reached). Scoped by
 * tool so it can only ever delete THIS tool's own stub. A completed row has
 * pending:false and is never touched. Never throws.
 */
async function releaseClaim(ctx, idempotencyKey, toolName) {
  if (!idempotencyKey || !ctx?.user?.id) return;
  try {
    await McpActionLog.deleteOne({ user: ctx.user.id, tool: toolName, idempotencyKey, pending: true });
  } catch { /* best-effort; a leftover stub goes stale-reclaimable, then TTL */ }
}

module.exports = { logAction, replay, releaseClaim, CLAIM_STALE_MS };
