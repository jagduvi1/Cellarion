// Sommelier tools: prices — the price-request queue, a new valuation snapshot
// and a reasoned decline. Thin tools over services/priceOps, the body the
// REST somm price routes share.
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const PriceTrackingRequest = require('../../../models/PriceTrackingRequest');
const WineDefinition = require('../../../models/WineDefinition');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAction } = require('../../actionLedger');
const { isValidId } = require('../../../utils/validation');
const { SUPPORTED_CURRENCIES } = require('../../../config/currencies');
const priceOps = require('../../../services/priceOps');
const { wineLite } = require('./shared');

registerTool({
  name: 'list_price_tracking_requests',
  title: 'Sommelier: list the price-request queue',
  description:
    'Lists wine+vintage pairs users have asked to have price-tracked, where no price exists yet or the latest is ' +
    'older than 3 months. Most-requested first. Call when the somm asks "any price requests waiting?"; fulfil with ' +
    'set_vintage_price, or decline unsuitable ones (no secondary market) with reject_price_request. Declined pairs ' +
    'no longer appear here.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(20),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const requests = await PriceTrackingRequest.find({})
      .populate({ path: 'wineDefinition', select: 'name producer type', populate: ['country', 'region'] })
      .lean();
    // Declined pairs hidden, stale-or-missing prices kept, queue order: the
    // same body as GET /api/somm/prices/queue (services/priceOps).
    const actionable = await priceOps.actionablePriceRequests(requests);

    const data = actionable.slice(0, limit).map(({ request: r, latest }) => ({
      request_id: r._id,
      wine: wineLite(r.wineDefinition),
      vintage: r.vintage,
      requester_count: r.requesters?.length || 0,
      first_requested_at: r.firstRequestedAt || null,
      latest_price: latest ? { price: latest.price, currency: latest.currency, set_at: latest.setAt } : null,
    }));
    return ok(`${actionable.length} actionable price request(s)${actionable.length > limit ? ` (showing ${limit})` : ''}`, data);
  },
});

registerTool({
  name: 'set_vintage_price',
  title: 'Sommelier: add a price valuation for a vintage',
  description:
    'Records a new price snapshot for one wine+vintage (price history accumulates — this never overwrites). ' +
    'Requesters are notified, and the pair leaves the price queue until the snapshot goes stale. This is SHARED ' +
    'valuation data — confirm price, currency and source with the somm first. Reversible via undo_last (removes the ' +
    'snapshot).',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId,
    vintage: z.string().min(1).max(10),
    price: z.number().min(0),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Default USD'),
    source: z.string().max(100).optional().describe('e.g. auction, retail, Systembolaget'),
    somm_notes: z.string().max(2000).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const currency = priceOps.normalizeCurrency(args.currency);
    if (!currency.ok) {
      return fail('invalid_input', `Unsupported currency ${currency.value}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`);
    }
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');
    // The bottles' canonical vintage, as on REST; the refusal wording is this door's.
    const vintage = priceOps.parsePriceVintage(args.vintage);
    if (!vintage.ok) {
      if (vintage.code === 'required') return fail('invalid_input', 'vintage is required: a year or NV.');
      if (vintage.code === 'unknown') return fail('invalid_input', 'A price needs a vintage year or NV.');
      return fail('invalid_input', vintage.error);
    }
    const wine = await WineDefinition.findById(args.wine_id).select('name producer draft');
    if (!wine || wine.draft === true) return fail('not_found', 'No registry wine with that id.');

    // Rate snapshot, save, audit and the requesters' notification: the same
    // body as POST /api/somm/prices (services/priceOps).
    const entry = await priceOps.addPriceSnapshot({
      wineId: wine._id,
      vintage: vintage.value,
      price: args.price,
      currency: currency.value,
      source: args.source,
      sommNotes: args.somm_notes,
      actorId: ctx.user.id,
      wine,
      req: ctx.req,
      via: 'mcp',
    });

    const envelope = {
      summary: `Price recorded: ${wine.name} ${entry.vintage} = ${entry.price} ${entry.currency}`,
      data: {
        price_entry_id: entry._id,
        wine_id: wine._id,
        vintage: entry.vintage,
        price: entry.price,
        currency: entry.currency,
        undo: 'undo_last removes this snapshot',
      },
    };
    await logAction(ctx, {
      tool: 'set_vintage_price',
      action: 'somm_price',
      detail: { entryId: String(entry._id), wineId: String(wine._id), vintage: entry.vintage },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// The same bounds, audit action string and requester wording as
// POST /api/somm/prices/requests/:id/decline, from the shared service.
const { DECLINE_REASON_MIN, DECLINE_REASON_MAX } = priceOps;

registerTool({
  name: 'reject_price_request',
  title: 'Sommelier: decline a price-tracking request',
  description:
    'Declines one price-tracking request WITH a required reason — for pairs that fail the secondary-market test ' +
    '(everyday retail wines with no auction/resale data) or are otherwise not worth tracking. Every requester is ' +
    'notified with the reason VERBATIM — confirm the wording with the somm first. The pair leaves the queue and ' +
    'future tracking requests for the same wine+vintage are refused while the decline stands. Get request_id from ' +
    'list_price_tracking_requests. To fulfil instead, use set_vintage_price. Reversible via undo_last (restores the ' +
    'request and lifts the suppression; the notifications already sent stand).',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    request_id: objectId.describe('From list_price_tracking_requests'),
    reason: z.string().min(DECLINE_REASON_MIN).max(DECLINE_REASON_MAX)
      .describe('Why tracking is declined — sent verbatim to the requester(s), e.g. "Everyday retail wine with no secondary market; prices would not be meaningful."'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    // The reason reaches the skip document and the requester notifications:
    // plain text only, bounded after the strip. The wording is this door's.
    const checked = priceOps.validateDeclineReason(args.reason);
    if (!checked.ok) {
      return fail('invalid_input', checked.code === 'long'
        ? `reason must be at most ${DECLINE_REASON_MAX} characters.`
        : `reason must be at least ${DECLINE_REASON_MIN} characters of plain text (HTML is stripped) — the requester(s) read it.`);
    }
    const { reason } = checked;

    const request = await PriceTrackingRequest.findById(args.request_id);
    if (!request) {
      return fail('not_found', 'No such price-tracking request — it may already be fulfilled or declined. Use list_price_tracking_requests for valid ids.');
    }

    // Skip upserted (the suppression routes/bottlePriceTracking.js refuses on), request
    // deleted, requesters told verbatim, audited: the same body as the REST
    // decline (services/priceOps). `prev` is all the undo has to work from.
    const declined = await priceOps.declinePriceRequest({ request, reason, actorId: ctx.user.id, req: ctx.req, via: 'mcp' });
    // Another curator declined it between the load above and the delete:
    // nothing was changed here, so there is nothing to ledger either.
    if (declined.gone) {
      return fail('not_found', 'No such price-tracking request — it may already be fulfilled or declined. Use list_price_tracking_requests for valid ids.');
    }
    const { prev, wine } = declined;

    const envelope = {
      summary: `Declined price tracking for ${wine?.name || 'wine'} ${request.vintage} — ${prev.requesters.length} requester(s) notified with the reason`,
      data: {
        request_id: String(request._id),
        wine_id: String(request.wineDefinition),
        vintage: request.vintage,
        reason,
        requesters_notified: prev.requesters.length,
        suppressed: true,
        note: 'Future tracking requests for this wine+vintage are refused while the decline stands.',
        undo: 'undo_last restores the request and lifts the suppression',
      },
    };
    await logAction(ctx, {
      tool: 'reject_price_request',
      action: 'somm_price_decline',
      detail: { requestId: String(request._id), wineId: String(request.wineDefinition), vintage: request.vintage, reason },
      prev,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
