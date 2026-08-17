// Public key vocabulary + values over MCP (#985 Slice B). All semantics live
// in services/registryDataOps.js, shared with routes/registryData.js and
// routes/admin/registryData.js. Users propose keys and suggest values;
// admins decide — nothing auto-applies to the registry.
const { z } = require('zod');
const { registerTool } = require('../registry');
const ops = require('../../services/registryDataOps');
const { ok, fail, objectId } = require('../toolUtil');
const { TYPES } = require('../../utils/personalDataTypes');

const FAIL_CODE = {
  invalid: 'invalid_input',
  limit: 'rate_limited',
  banned: 'forbidden_scope',
  not_found: 'not_found',
  conflict: 'conflict',
};
const svcFail = (r) => fail(FAIL_CODE[r.code] || 'invalid_input', r.message);

const requireAdmin = (ctx) =>
  (ctx.user?.roles || []).includes('admin')
    ? null
    : fail('forbidden_scope', 'This tool needs the admin role.');

registerTool({
  name: 'get_wine_public_data',
  title: 'Public data fields on a registry wine',
  description:
    'The accepted public key vocabulary (ABV etc.) with each key\'s published value for this wine — blanks included, ' +
    'because a visible gap is an invitation to contribute. Also returns the user\'s own pending suggestions.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { wine_id: objectId },
  handler: async (args, ctx) => {
    const result = await ops.dataForWine(args.wine_id, ctx.user.id);
    if (!result.ok) return svcFail(result);
    const fields = result.fields.map((f) => ({
      key_id: f.key._id,
      key: f.key.name,
      type: f.key.type,
      unit: f.key.unit,
      ...(f.key.enumOptions ? { options: f.key.enumOptions } : {}),
      value: f.value,
      contributed_by: f.contributedBy,
      my_pending_suggestion: f.mySuggestion ? f.mySuggestion.value : null,
    }));
    return ok(`${fields.length} public field(s), ${fields.filter((f) => f.value !== null).length} filled for this wine`, { fields });
  },
});

registerTool({
  name: 'suggest_wine_public_value',
  title: 'Suggest a value for a public data field (admin-reviewed)',
  description:
    'Files a value suggestion for an ACCEPTED public key on a registry wine (key_id from get_wine_public_data). ' +
    'The value is validated against the key\'s type; an admin publishes or rejects it — nothing auto-applies. ' +
    'Confirm the value with the user first; evidence (a URL) speeds up review. Daily budget shared with ' +
    'suggest_wine_correction and propose_registry_key.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId,
    key_id: objectId,
    value: z.union([z.string().max(500), z.number(), z.boolean()]),
    reason: z.string().max(1000).optional().describe('How the user knows (label, producer site …)'),
    evidence_url: z.string().max(500).optional(),
  },
  handler: async (args, ctx) => {
    const result = await ops.suggestValue(
      ctx.user.id,
      { wineId: args.wine_id, keyId: args.key_id, value: args.value, reason: args.reason, evidenceUrl: args.evidence_url },
      { via: 'mcp', req: ctx.req }
    );
    if (!result.ok) return svcFail(result);
    return ok(`Suggested ${result.value.key.name} = ${JSON.stringify(result.value.value)} (admin will review)`, {
      value_id: result.value._id,
      status: 'suggested',
    });
  },
});

registerTool({
  name: 'propose_registry_key',
  title: 'Propose a NEW public data field (admin-reviewed)',
  description:
    'Proposes a new key for the shared public vocabulary — name, a type from the shared type system ' +
    `(${TYPES.join(' | ')}, unit on numeric keys, options on enum keys) and a rationale for why it deserves to be ` +
    'first-class. Creating a public key is a curated act: an admin accepts it before anyone can suggest values. ' +
    'Check get_wine_public_data first — the key may already exist.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    name: z.string().trim().min(1).max(60),
    type: z.enum(TYPES),
    unit: z.string().max(20).optional(),
    enum_options: z.array(z.string().max(40)).min(2).max(20).optional(),
    rationale: z.string().min(10).max(1000),
  },
  handler: async (args, ctx) => {
    const result = await ops.proposeKey(
      ctx.user.id,
      { name: args.name, type: args.type, unit: args.unit, enumOptions: args.enum_options, rationale: args.rationale },
      { via: 'mcp', req: ctx.req }
    );
    if (!result.ok) return svcFail(result);
    return ok(`Proposed public key "${result.key.name}" (${result.key.type}) — admin will review`, {
      key_id: result.key._id,
      status: 'proposed',
    });
  },
});

registerTool({
  name: 'review_registry_data',
  title: 'Admin: review proposed keys and suggested values',
  description:
    'ADMIN only. Lists the two review queues (proposed public keys, suggested values), or decides one row: ' +
    'decide "accept"/"reject" for a key_id, "publish"/"reject" for a value_id. Publishing a value supersedes any ' +
    'previously published value for that wine+key.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    key_id: objectId.optional(),
    value_id: objectId.optional(),
    decision: z.enum(['accept', 'reject', 'publish']).optional(),
    reject_reason: z.string().max(500).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireAdmin(ctx);
    if (denied) return denied;

    if (!args.key_id && !args.value_id) {
      const result = await ops.listReviewQueues();
      return ok(`${result.keys.length} proposed key(s), ${result.values.length} suggested value(s)`, {
        proposed_keys: result.keys.map((k) => ({
          key_id: k._id, name: k.name, type: k.type, unit: k.unit || null,
          options: k.enumOptions || null, rationale: k.rationale,
          proposed_by: k.proposedBy?.username || null, tier: k.proposedBy?.contribution?.tier || null,
        })),
        suggested_values: result.values.map((v) => ({
          value_id: v._id, key: v.key?.name, value: v.value,
          wine: v.wineDefinition ? `${v.wineDefinition.producer || '?'} — ${v.wineDefinition.name}` : null,
          reason: v.reason || null, evidence_url: v.evidenceUrl || null,
          suggested_by: v.suggestedBy?.username || null, tier: v.suggestedBy?.contribution?.tier || null,
        })),
      });
    }

    if (!args.decision) return fail('invalid_input', 'Pass decision together with key_id or value_id.');
    if (args.key_id && args.value_id) return fail('invalid_input', 'Decide ONE row per call: key_id OR value_id.');

    if (args.key_id) {
      if (!['accept', 'reject'].includes(args.decision)) {
        return fail('invalid_input', "A key decision is 'accept' or 'reject'.");
      }
      const result = await ops.decideKey(ctx.user.id, args.key_id, args.decision, args.reject_reason, { req: ctx.req });
      if (!result.ok) return svcFail(result);
      return ok(`Key "${result.key.name}" ${result.key.status}`, { key: result.key });
    }

    if (!['publish', 'reject'].includes(args.decision)) {
      return fail('invalid_input', "A value decision is 'publish' or 'reject'.");
    }
    const result = await ops.decideValue(ctx.user.id, args.value_id, args.decision, args.reject_reason, { req: ctx.req });
    if (!result.ok) return svcFail(result);
    return ok(`Value ${result.value.status}`, { value: result.value });
  },
});

module.exports = {};
