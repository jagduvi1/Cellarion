// User-facing registry correction suggestions (#985 Slice A) — the regular-
// user counterpart of the sommelier's propose_wine_correction (somm.js).
// Field corrections only; merge / non-wine stay sommelier tools. All
// semantics (validation, tier budget, ban, one-pending conflict) live in
// services/wineProposalOps.js, shared with routes/wineProposals.js.
const { z } = require('zod');
const { registerTool } = require('../registry');
const ops = require('../../services/wineProposalOps');
const { ok, fail, objectId } = require('../toolUtil');
// A suggestion cannot be withdrawn, so a retry after an ambiguous transport
// failure must be safe: idempotency_key claims/replays through the ledger
// (support ticket 2026-09-12).
const { logAction, replay } = require('../actionLedger');
// The replayable body stored on the ledger row: what ok() serialises.
const envelopeOf = (summary, data) => ({ summary, data });
const RETRY_NOTE = 'Cannot be unsent. Pass an idempotency_key (any unique string) so a retry after a transport error ' +
  'replays the original result instead of filing twice; on a transport error WITHOUT a key, read back ' +
  '(get_wine → pending_correction) before retrying.';

const FAIL_CODE = {
  invalid: 'invalid_input',
  limit: 'rate_limited',
  banned: 'forbidden_scope',
  not_found: 'not_found',
  conflict: 'conflict',
};

registerTool({
  name: 'suggest_wine_correction',
  title: 'Suggest a correction to a registry wine (admin-reviewed)',
  description:
    'Files a SUGGESTION to fix a shared registry wine — the identity fields producer, name, appellation, region, ' +
    'country, classification, and the structural fields type and grapes. `grapes` REPLACES the whole variety list ' +
    '(send every variety the wine has, as on the label; names must exist in the taxonomy — describe_grape finds the ' +
    'canonical one). Available to every user; nothing changes until an admin approves the diff. Give a ' +
    'reason saying what is wrong and how you know; an evidence URL (producer site, appellation register) makes ' +
    'one-click approval possible. Daily suggestion budget grows with the user\'s accepted contributions. ' +
    'ONE pending suggestion per wine, across ALL users: while the user\'s OWN suggestion is awaiting review, filing ' +
    'again on that wine AMENDS it (new fields merged in, this reason and evidence recorded as an amendment, no budget ' +
    'spent, at most 10 amendments per suggestion) — the way to add a fix ' +
    'noticed right after filing; while SOMEONE ELSE\'s is pending the call fails with conflict. Check get_wine → ' +
    'pending_correction first: it says whether a suggestion is pending, which fields it covers and whether it is ' +
    'the caller\'s. NOT undoable via undo_last — an admin reads and decides. Sommeliers proposing merges or ' +
    'non-wine flags use propose_wine_correction instead. ' + RETRY_NOTE,
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId,
    idempotency_key: z.string().max(100).optional().describe('Unique key: a retry with the same key returns the original result instead of filing again'),
    fields: z.object({
      producer: z.string().max(200).optional(),
      name: z.string().max(200).optional(),
      appellation: z.string().max(200).optional(),
      region: z.string().max(200).optional(),
      country: z.string().max(200).optional(),
      classification: z.string().max(200).optional(),
      type: z.enum(['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified']).optional()
        .describe('The wine\'s colour/style, when the record has it wrong'),
      grapes: z.array(z.string().min(1).max(60)).min(1).max(12).optional()
        .describe('The COMPLETE corrected variety list (replaces the current one); every name must already be in the taxonomy'),
    }).describe('Only the fields that should CHANGE, with their corrected values'),
    reason: z.string().min(10).max(1000).describe('What is wrong and how it was verified'),
    evidence_url: z.string().max(500).optional().describe('http(s) link backing the claim — strongly encouraged'),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'suggest_wine_correction');
    if (replayed) return replayed;

    const result = await ops.createFieldCorrection(
      ctx.user.id,
      { wineId: args.wine_id, fields: args.fields, reason: args.reason, evidenceUrl: args.evidence_url },
      { via: 'mcp', req: ctx.req }
    );
    if (!result.ok) {
      const hint = result.code === 'conflict' ? ' get_wine → pending_correction shows which fields it covers.' : '';
      return fail(FAIL_CODE[result.code] || 'invalid_input', result.message + hint);
    }
    const pf = result.proposal.proposedFields;
    const allFields = Object.keys(pf && typeof pf.toObject === 'function' ? pf.toObject() : pf || {});
    const label = `${result.wine.producer || '?'} — ${result.wine.name}`;
    const envelope = result.amended
      ? envelopeOf(
        `Your pending suggestion for ${label} was amended with ${result.amendedFields.join(', ')} — it now covers ${allFields.join(', ')} (admin will review)`,
        {
          proposal_id: result.proposal._id,
          status: 'pending',
          amended: true,
          fields: allFields,
          amendments: (result.proposal.amendments || []).length,
          note: 'No new queue row: the fields were merged into the suggestion already awaiting review, and no daily budget was spent.',
        }
      )
      : envelopeOf(
        `Suggestion filed for ${label}: ${allFields.join(', ')} (admin will review)`,
        {
          proposal_id: result.proposal._id,
          status: 'pending',
          amended: false,
          fields: allFields,
          note: 'An admin reviews the diff; the record changes only on approval. The user can see the outcome on the bottle page.',
        }
      );
    // Ledger row (not undo-eligible): completes the idempotency claim so a
    // retry replays this envelope; also the activity-timeline record.
    await logAction(ctx, {
      tool: 'suggest_wine_correction', action: 'suggest_correction',
      detail: { wineId: String(result.wine._id), proposalId: String(result.proposal._id), fields: allFields, amended: !!result.amended },
      idempotencyKey: args.idempotency_key || null, result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
