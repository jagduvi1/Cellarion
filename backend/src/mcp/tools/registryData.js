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
    const result = await ops.dataForWine(args.wine_id, ctx.user.id, { roles: ctx.user.roles });
    if (!result.ok) return svcFail(result);
    const fields = result.fields.map((f) => ({
      key_id: f.key._id,
      key: f.key.name,
      type: f.key.type,
      unit: f.key.unit,
      ...(f.key.enumOptions ? { options: f.key.enumOptions } : {}),
      value: f.value,
      contributed_by: f.contributedBy,
      // A pending suggestion (anyone's) holds this key's one review slot —
      // do not file another; it would only conflict.
      suggestion_pending: f.hasPendingSuggestion,
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
  title: 'Sommelier: review proposed keys and suggested values',
  description:
    'The public-data review queues: proposed keys (the vocabulary itself) and suggested values users have offered ' +
    'for a wine. Call with no arguments to list both, or decide one row: "accept"/"reject" for a key_id, ' +
    '"publish"/"reject" for a value_id. Publishing a value supersedes any previously published value for that ' +
    'wine+key. ' +
    'JUDGE THE TWO QUEUES DIFFERENTLY. A suggested VALUE is a fact about one wine — is 14.5% the right ABV for ' +
    'this bottling? — and that is ordinary curation, same as any other wine data. A proposed KEY is a decision ' +
    'about what the registry TRACKS AT ALL: accepting one adds it to the public vocabulary every wine can carry ' +
    'and to the analytics fields, and values then accumulate against it. Judge a key on whether it is a durable, ' +
    'objective property of a wine that owners would actually fill in — not merely whether the suggestion is ' +
    'true. When a key is really a product question rather than a wine question, reject it with that as the ' +
    'reason and say so in a support ticket rather than accepting on your own.',
  scope: 'write',
  // Sommelier + admin (Johan, 2026-08-23). Public wine data IS wine data, and
  // the admin-only gate made the project owner the bottleneck on a queue fed
  // by users — the same bottleneck somm-owned data exists to remove.
  //
  // Deliberately MORE permissive than the REST twin at
  // /api/admin/registry-data, which stays requireRole('admin'): that route
  // backs the admin web UI, while MCP is the sommelier's surface. Not drift —
  // the same split as the maturity queue (somm over MCP, admin over REST).
  //
  // Structural gate: the tool is INVISIBLE to connections without the role
  // (the registry filters on requireRole) — an in-handler check alone would
  // leave it listed to every write-scope user, who then hit forbidden_scope
  // noise.
  requireRole: ['somm', 'admin'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    key_id: objectId.optional(),
    value_id: objectId.optional(),
    decision: z.enum(['accept', 'reject', 'publish']).optional(),
    reject_reason: z.string().max(500).optional(),
  },
  handler: async (args, ctx) => {
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

    // Per-kind decision vocabulary is validated by the service (one owner).
    if (args.key_id) {
      const result = await ops.decideKey(ctx.user.id, args.key_id, args.decision, args.reject_reason, { req: ctx.req });
      if (!result.ok) return svcFail(result);
      return ok(`Key "${result.key.name}" ${result.key.status}`, { key: result.key });
    }

    const result = await ops.decideValue(ctx.user.id, args.value_id, args.decision, args.reject_reason, { req: ctx.req });
    if (!result.ok) return svcFail(result);
    return ok(`Value ${result.value.status}`, { value: result.value });
  },
});

module.exports = {};
