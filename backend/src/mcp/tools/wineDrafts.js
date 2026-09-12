/**
 * Private draft wines over MCP (support ticket 2026-09-12): the connector's
 * half of the draft lifecycle. add_bottle / bulk_add create a draft with
 * `draft:true`; here the caller lists their drafts, edits one in place (no
 * correction queue — nothing is shared yet) and publishes one or many, with
 * the registry's "attach your bottles to this existing wine instead" answer
 * when publish meets a match. Everything delegates to
 * services/wineDraftOps, the same implementation the web app uses.
 */
const { z } = require('zod');
const { registerTool } = require('../registry');
const { ok, fail, objectId } = require('../toolUtil');
const ops = require('../../services/wineDraftOps');

const DRAFT_NOTE = 'A private draft is visible only to its creator (and to members of shared cellars holding a bottle of it). ' +
  'Left untouched for 7 days, a draft holding bottles publishes by itself; an empty one is deleted.';

registerTool({
  name: 'list_wine_drafts',
  title: 'List my private draft wines',
  description:
    'Every wine the user created as a PRIVATE DRAFT (add_bottle / bulk_add with draft:true): identity fields, bottle ' +
    'count and the untouched-clock deadline (draft_expires_at). ' + DRAFT_NOTE + ' Use update_wine_draft to finish a ' +
    'record and publish_wine to move it into the shared registry.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  handler: async (args, ctx) => {
    const r = await ops.listDrafts(ctx.user.id);
    const drafts = r.drafts.map((d) => ({
      wine_id: String(d._id),
      name: d.name,
      producer: d.producer || null,
      appellation: d.appellation,
      classification: d.classification,
      type: d.type,
      country: d.country,
      region: d.region,
      grapes: d.grapes,
      bottle_count: d.bottleCount,
      draft_expires_at: d.draftExpiresAt,
      created_at: d.createdAt,
    }));
    return ok(`${drafts.length} private draft wine(s)`, {
      drafts,
      ...(drafts.length ? { guidance: 'Finish each record with update_wine_draft, then publish_wine (one wine_id, or wine_ids for a batch). A draft with 0 bottles is deleted when its clock lapses.' } : {}),
    });
  },
});

registerTool({
  name: 'update_wine_draft',
  title: 'Edit my private draft wine',
  description:
    'Edits one of the user\'s PRIVATE DRAFT wines in place — no review, nothing is shared yet. Send only the fields ' +
    'to change. Country must be one the registry knows; grapes are the COMPLETE variety list, taxonomy names ' +
    '(synonyms resolve); the producer may be emptied. Every edit restarts the 7-day untouched clock. Use ' +
    'suggest_wine_correction for a PUBLISHED wine instead.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId,
    name: z.string().max(200).optional(),
    producer: z.string().max(200).optional().describe('"" clears it'),
    appellation: z.string().max(200).optional(),
    classification: z.string().max(200).optional(),
    type: z.enum(['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified']).optional(),
    country: z.string().max(200).optional(),
    region: z.string().max(200).optional(),
    grapes: z.array(z.string().min(1).max(60)).max(12).optional().describe('The COMPLETE variety list'),
  },
  handler: async (args, ctx) => {
    const loaded = await ops.loadOwnDraft(args.wine_id, ctx.user.id);
    if (!loaded.ok) return fail(loaded.code === 'invalid_input' ? 'invalid_input' : 'not_found', loaded.message);
    const patch = {};
    for (const k of ['name', 'producer', 'appellation', 'classification', 'type']) if (args[k] !== undefined) patch[k] = args[k];
    if (args.country !== undefined) patch.countryName = args.country;
    if (args.region !== undefined) patch.regionName = args.region;
    if (args.grapes !== undefined) patch.grapeNames = args.grapes;
    const v = ops.validateDraftPatch(patch);
    if (!v.ok) return fail('invalid_input', v.error);
    const r = await ops.updateDraft(loaded.wine, v.clean, ctx.user.id);
    if (!r.ok) return fail(r.code === 'conflict' ? 'conflict' : 'invalid_input', r.message);
    const { logAudit } = require('../../services/audit');
    logAudit(ctx.req, 'wine.draft_edit', { type: 'wine', id: r.wine._id }, { diff: r.diff, via: 'mcp' });
    const w = r.wine;
    return ok(`Draft updated: ${w.producer ? `${w.producer} — ` : ''}${w.name}`, {
      wine_id: String(w._id),
      changed: r.diff,
      draft_expires_at: w.draftExpiresAt,
      note: 'Still a private draft. publish_wine moves it into the shared registry.',
    });
  },
});

const outcomeOf = (r) => {
  if (r.ok) return { status: r.promoted ? 'published' : 'pending_curation' };
  const base = { status: r.code, error: r.message };
  if (r.match) base.match = r.match;
  if (r.candidates) base.candidates = r.candidates;
  return base;
};

registerTool({
  name: 'publish_wine',
  title: 'Publish a private draft wine to the registry',
  description:
    'Moves one of the user\'s PRIVATE DRAFT wines (or a batch, wine_ids) into the shared registry as it stands. ' +
    'Outcomes per wine: published; pending_curation (no producer — a curator completes it); duplicate (the registry ' +
    'already holds this wine — call again with attach_to:<match.wine_id> to move the bottles onto it, the draft is ' +
    'then dissolved); similar (close registry wines listed — attach_to one of them, or confirm_similar:true to ' +
    'publish as a genuinely new wine); invalid_identity (the producer is not usable — fix it with update_wine_draft). ' +
    'ALWAYS confirm with the user before publishing or attaching; neither is undoable via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.optional().describe('One draft'),
    wine_ids: z.array(objectId).min(1).max(ops.PUBLISH_BATCH_MAX).optional().describe('Several drafts (confirm_similar applies to all; attach_to is single-wine only)'),
    confirm_similar: z.boolean().optional().describe('Publish as a new wine despite similar registry wines'),
    attach_to: objectId.optional().describe('Single wine_id only: instead of publishing, move the draft\'s bottles onto this registry wine'),
  },
  handler: async (args, ctx) => {
    if (!args.wine_id && !args.wine_ids?.length) return fail('invalid_input', 'Provide wine_id or wine_ids.');
    if (args.wine_id && args.wine_ids?.length) return fail('invalid_input', 'Provide wine_id OR wine_ids, not both.');
    if (args.attach_to && !args.wine_id) return fail('invalid_input', 'attach_to applies to a single wine_id.');

    if (args.wine_id) {
      const loaded = await ops.loadOwnDraft(args.wine_id, ctx.user.id);
      if (!loaded.ok) return fail('not_found', loaded.message);
      if (args.attach_to) {
        const a = await ops.attachDraftBottles(loaded.wine, args.attach_to, { userId: ctx.user.id, roles: ctx.user.roles, req: ctx.req });
        if (!a.ok) return fail(a.code === 'not_found' ? 'not_found' : a.code === 'conflict' ? 'conflict' : 'invalid_input', a.message);
        return ok(`Attached ${a.bottlesMoved} bottle(s) to ${a.wine.producer ? `${a.wine.producer} — ` : ''}${a.wine.name}; the draft is gone`, {
          wine_id: String(a.wine._id), bottles_moved: a.bottlesMoved,
        });
      }
      const r = await ops.publishDraft(loaded.wine, { userId: ctx.user.id, req: ctx.req, confirmCreate: args.confirm_similar === true });
      const outcome = outcomeOf(r);
      if (r.ok) {
        return ok(r.promoted
          ? `Published ${r.wine.producer ? `${r.wine.producer} — ` : ''}${r.wine.name} to the shared registry`
          : `Published ${r.wine.name} as a pending row — a curator will complete the producer`,
          { wine_id: String(r.wine._id), ...outcome });
      }
      if (r.code === 'duplicate' || r.code === 'similar') {
        return fail('conflict', `${r.message} ${JSON.stringify({ wine_id: args.wine_id, ...outcome })}`);
      }
      return fail('invalid_input', r.message);
    }

    const r = await ops.publishDrafts(args.wine_ids, ctx.user.id, { req: ctx.req, confirmCreate: args.confirm_similar === true });
    if (!r.ok) return fail('invalid_input', r.message);
    const counts = r.results.reduce((acc, x) => ((acc[x.status] = (acc[x.status] || 0) + 1), acc), {});
    return ok(
      `Publish: ${r.results.length} draft(s) — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`,
      {
        results: r.results.map((x) => ({ wine_id: x.id, ...x, id: undefined })),
        guidance: 'For a duplicate row call publish_wine with that wine_id and attach_to:<match.wine_id>; for a similar row attach_to one of the candidates or confirm_similar:true; for invalid_identity fix the draft with update_wine_draft.',
      }
    );
  },
});
