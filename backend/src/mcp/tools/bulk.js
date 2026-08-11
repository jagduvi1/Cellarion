// bulk_add — the batch write with the plan's §5.7-L2 PREVIEW → APPLY contract:
// a hallucinated "add 60 bottles" is caught at the preview, before a single
// row changes. Two calls:
//
//   1. mode:'preview' (default) — resolves every item against the registry
//      (matchOnly — creates nothing), validates every field, and returns a
//      per-item plan + a preview_id. The model MUST show this plan to the
//      user for approval.
//   2. mode:'apply' { preview_id } — re-loads the stored plan (same user,
//      unconsumed, fresh), charges the mutation budget for the WHOLE batch
//      upfront, then executes serially (no parallel enrichment burst).
//      One ledger row for the whole batch → undo_last reverts it as a unit.
//
// findOrCreateWine is required lazily (meilisearch-ESM jest chain, see
// tools/write.js).
const { z } = require('zod');
const McpActionLog = require('../../models/McpActionLog');
const { registerTool } = require('../registry');
const { addBottle } = require('../../services/bottleOps');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { parseAndValidateVintage, parseDrinkYear } = require('../../utils/validation');
const { resolveRating } = require('../../utils/ratingUtils');
const WineDefinition = require('../../models/WineDefinition');
const { NEW_WINE_SHAPE } = require('./write');
const { ok, fail, objectId, MSG_CELLAR_NOT_FOUND, resolveCellarAccess, wineSummary } = require('../toolUtil');
const { logAction } = require('../actionLedger');
const { takeMutationSlot, ipKeyFor } = require('../mutationBudget');

const MAX_ITEMS = 24; // two cases — keeps one batch well inside the write budget
const PREVIEW_FRESH_MS = 15 * 60 * 1000;

const ITEM_SHAPE = z.object({
  wine_id: z.string().optional(),
  new_wine: z.object(NEW_WINE_SHAPE).optional(),
  confirm_new_wine: z.boolean().optional(),
  vintage: z.string().max(10).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  notes: z.string().max(5000).optional(),
  rating: z.number().min(0).max(100).optional(),
  rating_scale: z.enum(['5', '20', '100']).optional(),
  drink_from: z.number().int().optional(),
  drink_to: z.number().int().optional(),
});

/** Pure field validation shared by preview (report) and trusted at apply. */
function validateItemFields(item) {
  const v = parseAndValidateVintage(item.vintage);
  if (!v.ok) return v.error;
  const f = parseDrinkYear(item.drink_from, 'drink_from');
  if (!f.ok) return f.error;
  const t = parseDrinkYear(item.drink_to, 'drink_to');
  if (!t.ok) return t.error;
  if (f.value && t.value && f.value > t.value) return 'drink_from cannot be after drink_to';
  const r = resolveRating(item.rating, item.rating_scale);
  if (r.error) return r.error;
  return null;
}

async function planItem(item, userId) {
  if (!item.wine_id && !item.new_wine) return { status: 'invalid', error: 'wine_id or new_wine required' };
  if (item.wine_id && item.new_wine) return { status: 'invalid', error: 'wine_id OR new_wine, not both' };
  const fieldError = validateItemFields(item);
  if (fieldError) return { status: 'invalid', error: fieldError };

  if (item.wine_id) {
    if (!isValidId(item.wine_id)) return { status: 'invalid', error: 'wine_id must be a 24-hex id' };
    const wine = await WineDefinition.findById(item.wine_id).populate(['country', 'region', 'grapes']);
    if (!wine) return { status: 'invalid', error: `no registry wine ${item.wine_id}` };
    return { status: 'ready', wine_id: String(wine._id), wine: wineSummary(wine) };
  }

  const { findOrCreateWine } = require('../../services/findOrCreateWine');
  // producer is optional on NEW_WINE_SHAPE now; findOrCreateWine's .trim() runs
  // before any option is consulted, so a preview must hand it '' not undefined.
  const res = await findOrCreateWine(
    { ...item.new_wine, producer: item.new_wine.producer || '' },
    userId,
    { matchOnly: true }
  );
  if (res.wine) {
    // Registry already knows it — upgrade the item to the existing wine.
    return { status: 'ready', wine_id: String(res.wine._id), wine: wineSummary(res.wine), matched_existing: true };
  }
  if (res.candidates?.length) {
    if (item.confirm_new_wine) return { status: 'will_create', new_wine: item.new_wine, despite_candidates: true };
    return {
      status: 'blocked_similar',
      error: 'similar wines exist — pick a wine_id or set confirm_new_wine on this item',
      candidates: res.candidates.map((c) => ({ ...wineSummary(c.wine), score: c.score })),
    };
  }
  return { status: 'will_create', new_wine: item.new_wine };
}

registerTool({
  name: 'bulk_add',
  title: 'Add many bottles at once (preview, then apply)',
  description:
    `Adds up to ${MAX_ITEMS} bottles in one batch — for cases, deliveries, or import-style entry. TWO steps: first call ` +
    'with items (mode defaults to preview) — nothing is written; you get a per-item plan (matched wines, wines that ' +
    'would be newly created, problems). SHOW THE PLAN TO THE USER and get their approval. Then call again with ' +
    "mode:'apply' and the preview_id. The whole batch is one undo_last unit. Prefer resolve_wine-verified wine_ids in " +
    'items; new_wine items follow the same registry rules as add_bottle.',
  scope: 'write',
  // Charges the write budget ITSELF — one slot per item on apply, nothing on
  // preview — so the generic per-call charge in server.js must skip it or a
  // 12-bottle case would cost 14 (MCP-audit M7).
  selfBudgeted: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    mode: z.enum(['preview', 'apply']).default('preview'),
    cellar_id: objectId.optional().describe('Required for preview'),
    items: z.array(ITEM_SHAPE).min(1).max(MAX_ITEMS).optional().describe('Required for preview'),
    preview_id: z.string().optional().describe('Required for apply — from the preview response'),
  },
  handler: async (args, ctx) => {
    if ((args.mode || 'preview') === 'preview') {
      if (!args.cellar_id || !args.items?.length) {
        return fail('invalid_input', 'preview needs cellar_id and items[]');
      }
      const access = await resolveCellarAccess(ctx.user.id, args.cellar_id, 'editor');
      if (!access) return fail('not_found', MSG_CELLAR_NOT_FOUND);

      const plan = [];
      for (let i = 0; i < args.items.length; i++) {
        // Serial on purpose: bounded work, and registry lookups stay gentle.
        const p = await planItem(args.items[i], ctx.user.id);
        plan.push({ index: i, vintage: args.items[i].vintage || 'NV', ...p });
      }
      const counts = plan.reduce((acc, p) => ((acc[p.status] = (acc[p.status] || 0) + 1), acc), {});
      const applyable = !plan.some((p) => p.status === 'invalid' || p.status === 'blocked_similar');

      const row = await McpActionLog.create({
        user: ctx.user.id,
        tokenId: ctx.req?.apiToken?.id || null,
        tool: 'bulk_add',
        action: 'bulk_preview',
        cellar: access.cellar._id,
        detail: { counts, applyable },
        // The apply call re-reads items + plan from here — the client cannot
        // swap items between preview and apply.
        prev: { cellarId: String(access.cellar._id), items: args.items, plan },
        result: null,
      });
      return ok(
        `Preview: ${args.items.length} item(s) — ${counts.ready || 0} ready, ${counts.will_create || 0} new wine(s), ${counts.blocked_similar || 0} blocked, ${counts.invalid || 0} invalid${applyable ? '' : ' — NOT applyable yet'}`,
        {
          preview_id: String(row._id),
          applyable,
          plan,
          guidance: applyable
            ? 'Show this plan to the user. On their approval call bulk_add with mode:"apply" and this preview_id.'
            : 'Fix the blocked/invalid items (use listed candidate wine_ids or correct the fields) and preview again.',
        }
      );
    }

    // ── apply ──
    if (!args.preview_id || !isValidId(args.preview_id)) {
      return fail('invalid_input', 'apply needs the preview_id from a fresh preview');
    }
    const preview = await McpActionLog.findOne({
      _id: args.preview_id,
      user: ctx.user.id,
      action: 'bulk_preview',
      reversed: false,
    });
    if (!preview) return fail('not_found', 'No such (unused) preview — run a fresh preview.');
    if (Date.now() - preview.createdAt.getTime() > PREVIEW_FRESH_MS) {
      return fail('conflict', 'That preview has expired (15 min) — run a fresh preview.');
    }
    const { cellarId, items, plan } = preview.prev || {};
    if (!items?.length || plan.some((p) => p.status === 'invalid' || p.status === 'blocked_similar')) {
      return fail('conflict', 'That preview is not applyable — fix the flagged items and preview again.');
    }
    const access = await resolveCellarAccess(ctx.user.id, cellarId, 'editor');
    if (!access) return fail('not_found', MSG_CELLAR_NOT_FOUND);

    // Whole batch charged upfront — all-or-nothing against the write budget.
    if (!takeMutationSlot(String(ctx.user.id), items.length, ipKeyFor(ctx))) {
      return fail('rate_limited', `Not enough write budget left for ${items.length} adds this window — wait a few minutes, or split the batch.`);
    }
    // ATOMIC claim — plain doc.save() gives no concurrency guard here (no
    // optimisticConcurrency on this model), so consume the preview with a
    // conditional findOneAndUpdate: exactly ONE concurrent apply wins; the
    // loser gets null. prev is cleared in the same op (the ~items-sized blob
    // has no value after consumption; we already hold a copy in memory).
    const claimed = await McpActionLog.findOneAndUpdate(
      { _id: preview._id, reversed: false },
      { $set: { reversed: true, prev: null } }
    );
    if (!claimed) {
      return fail('conflict', 'That preview was just used by another request.');
    }

    const { findOrCreateWine } = require('../../services/findOrCreateWine');
    const added = [];
    const winesCreated = [];
    const failures = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const p = plan[i];
      try {
        let wineDoc;
        if (p.status === 'ready') {
          wineDoc = await WineDefinition.findById(p.wine_id);
          if (!wineDoc) { failures.push({ index: i, error: 'wine disappeared' }); continue; }
        } else {
          // Soft-zone stays live at apply time UNLESS the user explicitly
          // confirmed this item at preview (despite_candidates): candidates
          // that appeared since — most often a near-duplicate spelling minted
          // by an EARLIER item of this same batch — block the create instead
          // of silently bypassing the registry guard.
          const res = await findOrCreateWine(item.new_wine, ctx.user.id, {
            confirmCreate: !!p.despite_candidates, skipSiblingMatch: false, createdVia: 'mcp',
            // Same commit-path rule as add_bottle: an incomplete identity files
            // a pendingIdentity row for sommelier completion instead of losing
            // the bottle mid-batch.
            allowPending: true,
          });
          if (!res.wine) { failures.push({ index: i, error: 'similar wines appeared since the preview — resolve this item individually with resolve_wine' }); continue; }
          wineDoc = res.wine;
          if (res.created) {
            winesCreated.push(String(wineDoc._id));
            logAudit(ctx.req, 'wine.create', { type: 'wine', id: wineDoc._id }, { via: 'mcp', bulk: true, name: wineDoc.name, producer: wineDoc.producer || null, ...(wineDoc.pendingIdentity ? { pendingIdentity: true } : {}) });
          }
        }
        const result = await addBottle(access.cellar, wineDoc, {
          vintage: item.vintage,
          price: item.price,
          currency: item.currency,
          notes: item.notes,
          rating: item.rating,
          ratingScale: item.rating_scale,
          drinkFrom: item.drink_from,
          drinkTo: item.drink_to,
        }, ctx.req);
        if (result.error) failures.push({ index: i, error: result.error.message });
        else added.push(String(result.bottle._id));
      } catch (err) {
        failures.push({ index: i, error: err.message });
      }
    }

    const envelope = {
      summary: `Bulk add: ${added.length} bottle(s) added${winesCreated.length ? `, ${winesCreated.length} new registry wine(s)` : ''}${failures.length ? `, ${failures.length} FAILED` : ''} in "${access.cellar.name}"`,
      data: {
        added_bottle_ids: added,
        wines_created: winesCreated.length,
        failures,
        undo: 'undo_last reverts the whole batch (while all its bottles are still active)',
      },
    };
    await logAction(ctx, {
      tool: 'bulk_add',
      action: 'bulk_add',
      cellar: access.cellar._id,
      // createdWineIds: the ids (not just the count) so undo can garbage-collect
      // a wine THIS batch minted when nothing else references it (registryGc).
      detail: { bottles: added, count: added.length, wines_created: winesCreated.length, createdWineIds: winesCreated, failures: failures.length, previewId: String(preview._id) },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
