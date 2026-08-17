// User-facing registry correction suggestions (#985 Slice A) — the regular-
// user counterpart of the sommelier's propose_wine_correction (somm.js).
// Field corrections only; merge / non-wine stay sommelier tools. All
// semantics (validation, tier budget, ban, one-pending conflict) live in
// services/wineProposalOps.js, shared with routes/wineProposals.js.
const { z } = require('zod');
const { registerTool } = require('../registry');
const ops = require('../../services/wineProposalOps');
const { ok, fail, objectId } = require('../toolUtil');

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
    'Files a SUGGESTION to fix identity fields on a shared registry wine — producer, name, appellation, region, ' +
    'country, classification. Available to every user; nothing changes until an admin approves the diff. Give a ' +
    'reason saying what is wrong and how you know; an evidence URL (producer site, appellation register) makes ' +
    'one-click approval possible. Daily suggestion budget grows with the user\'s accepted contributions. ' +
    'NOT undoable via undo_last — an admin reads and decides. Sommeliers proposing merges or non-wine flags use ' +
    'propose_wine_correction instead.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId,
    fields: z.object({
      producer: z.string().max(200).optional(),
      name: z.string().max(200).optional(),
      appellation: z.string().max(200).optional(),
      region: z.string().max(200).optional(),
      country: z.string().max(200).optional(),
      classification: z.string().max(200).optional(),
    }).describe('Only the fields that should CHANGE, with their corrected values'),
    reason: z.string().min(10).max(1000).describe('What is wrong and how it was verified'),
    evidence_url: z.string().max(500).optional().describe('http(s) link backing the claim — strongly encouraged'),
  },
  handler: async (args, ctx) => {
    const result = await ops.createFieldCorrection(
      ctx.user.id,
      { wineId: args.wine_id, fields: args.fields, reason: args.reason, evidenceUrl: args.evidence_url },
      { via: 'mcp', req: ctx.req }
    );
    if (!result.ok) return fail(FAIL_CODE[result.code] || 'invalid_input', result.message);
    return ok(
      `Suggestion filed for ${result.wine.producer || '?'} — ${result.wine.name}: ${Object.keys(result.proposal.proposedFields.toObject ? result.proposal.proposedFields.toObject() : result.proposal.proposedFields).join(', ')} (admin will review)`,
      {
        proposal_id: result.proposal._id,
        status: 'pending',
        note: 'An admin reviews the diff; the record changes only on approval. The user can see the outcome on the bottle page.',
      }
    );
  },
});

module.exports = {};
