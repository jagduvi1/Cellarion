// Sommelier tools: owner inquiries — the channel for record questions only a
// bottle's OWNER can settle ("what does the label say?").
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const mongoose = require('mongoose');
const WineOwnerInquiry = require('../../../models/WineOwnerInquiry');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, pageParams, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAction } = require('../../actionLedger');
const {
  QUESTION_MIN,
  QUESTION_MAX,
  NOTE_MIN,
  NOTE_MAX,
  OWNER_REPLY_MAX,
  createOwnerInquiry,
  resolveOwnerInquiry,
  sweepExpiredInquiries,
  queryInquiryPage,
} = require('../../../services/ownerInquiryOps');
const { wineLite } = require('./shared');

// Owner inquiries — the channel for record questions only a bottle's OWNER
// can settle ("what does the label say?"). Both tools ride the shared
// services/ownerInquiryOps so REST and MCP cannot drift on recipient
// building, conflict semantics or queue order. Recipients are ANONYMISED on
// this surface — a curator needs the answers, never the owners' identities
// (the admin REST queue is the only place identities show).
const INQUIRY_STATUS_FILTERS = ['active', 'open', 'answered', 'resolved', 'closed', 'decided'];

registerTool({
  name: 'ask_bottle_owner',
  title: 'Sommelier: ask a wine\'s bottle owners about their record',
  description:
    'Sends a question about a registry wine to the users who OWN bottles of it (in-app notification, and an email ' +
    'unless the owner turned it off; owners answer ' +
    'from their bottle page, answers land in the owner-inquiry queue). THE tool for record facts research cannot ' +
    'settle — "what does the label say the producer is?", "is this the DOCG or the DOC bottling?". Owners with ' +
    'ACTIVE bottles are asked; when none exist, owners who consumed one are asked instead. Capped at 20 owners. One ' +
    'open inquiry per wine — a second ask conflicts until the first is resolved. Works on pending-identity wines ' +
    'too, and is the RIGHT escalation when the label scan cannot answer the question: the owner has the bottle in ' +
    'hand and can read the back label ("Mis en bouteille par…") when the front prints no producer. This notifies ' +
    'real people: confirm the wording with the somm first. NOT reversible via undo_last (notifications cannot be ' +
    'unsent). Read the answers later with list_owner_inquiries.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_maturity_queue, search_registry or get_wine'),
    question: z.string().min(QUESTION_MIN).max(QUESTION_MAX)
      .describe(`The question the owners read VERBATIM (${QUESTION_MIN}–${QUESTION_MAX} chars, plain text) — e.g. "Could you check the label: is the producer written as ‘E. Pira e Figli’ or just ‘Pira’?"`),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    // ONE implementation with the REST create route — identical validation,
    // conflict semantics and audit action string (via:'mcp' in the detail).
    const result = await createOwnerInquiry({
      wineId: args.wine_id,
      userId: ctx.user.id,
      via: 'mcp',
      question: args.question,
      req: ctx.req,
    });
    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', result.message + ' Use search_registry to find it.');
      if (result.code === 'conflict') return fail('conflict', result.message + ' Check it with list_owner_inquiries.');
      if (result.code === 'no_owners') {
        return fail('conflict', result.message + ' There is nobody to ask — settle the record another way (propose_wine_correction with evidence, or a support ticket).');
      }
      return fail('invalid_input', result.message);
    }

    const label = [result.wine.producer, result.wine.name].filter(Boolean).join(' — ');
    return ok(
      `Inquiry sent to ${result.recipientCount} bottle owner(s) of ${label}${result.fallbackUsed ? ' (no bottles still in a cellar — owners of consumed bottles were asked)' : ''}`,
      {
        inquiry_id: result.inquiry._id,
        wine_id: result.wine._id,
        status: 'open',
        recipients_notified: result.recipientCount,
        asked_consumed_owners: result.fallbackUsed,
        expires_at: result.inquiry.expiresAt,
        note: 'Owners are told in-app and, where their settings allow, by email; they answer in the app, and answers appear in list_owner_inquiries. The inquiry expires after 60 days. Not undoable — the notifications are already out.',
      }
    );
  },
});

registerTool({
  name: 'list_owner_inquiries',
  title: 'Sommelier: list owner inquiries and their answers',
  description:
    'Lists owner inquiries (questions sent to bottle owners via ask_bottle_owner) WITH the answers owners have ' +
    'given — this is how a curator reads the replies. Answered first, then open, then decided. Pass wine_id to ' +
    'check one wine, status to narrow ("active" = open+answered is the default; "decided" = resolved+closed). ' +
    'Recipients are anonymised ("owner 1", "owner 2") — identities are never exposed here; judge the answers on ' +
    'content. Once the record is fixed, close the loop with resolve_owner_inquiry — it replies to the owners who ' +
    'answered. (Applying an IDENTITY field is still an admin step: propose_wine_correction.)',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(INQUIRY_STATUS_FILTERS).optional().describe('Default "active" (open + answered)'),
    wine_id: objectId.optional().describe('Scope to one registry wine'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);

    // Expired open inquiries leave as 'closed' before the queue renders —
    // same lazy sweep the admin REST list runs.
    await sweepExpiredInquiries();

    // Filter values are literals from the static array, never raw input.
    const status = INQUIRY_STATUS_FILTERS.includes(args.status) ? args.status : 'active';
    const filter = {};
    if (status === 'active') filter.status = { $in: ['open', 'answered'] };
    else if (status === 'decided') filter.status = { $in: ['resolved', 'closed'] };
    else filter.status = status;
    // Cast REQUIRED: queryInquiryPage runs an aggregate, and Mongoose does not
    // cast $match values in pipelines — a hex STRING matches nothing while the
    // sibling countDocuments (which does cast) still counts (audit M-1).
    if (args.wine_id) filter.wineDefinition = new mongoose.Types.ObjectId(args.wine_id);

    const { rows, total, pendingCount, answeredCount } = await queryInquiryPage(filter, { limit, offset });
    await WineOwnerInquiry.populate(rows, [
      { path: 'wineDefinition', select: 'name producer type appellation', populate: ['country', 'region'] },
    ]);

    const data = rows.map((i) => ({
      inquiry_id: i._id,
      wine: wineLite(i.wineDefinition),
      status: i.status,
      question: i.question,
      asked_via: i.askedVia || 'rest',
      created_at: i.createdAt,
      expires_at: i.expiresAt || null,
      // Anonymised, positionally stable labels — answers without identities.
      recipients: (i.recipients || []).map((r, idx) => ({
        label: `owner ${idx + 1}`,
        notified_at: r.notifiedAt || null,
        responded: !!r.response,
        response: r.response || null,
        responded_at: r.respondedAt || null,
      })),
      response_count: (i.recipients || []).filter((r) => r.response).length,
      recipient_count: (i.recipients || []).length,
      resolution_note: i.resolutionNote || null,
      resolved_at: i.resolvedAt || null,
    }));

    return ok(
      `${answeredCount} inquiry(ies) with answers waiting, ${pendingCount} active in total (showing ${data.length} of ${total} ${status})`,
      data,
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'resolve_owner_inquiry',
  title: 'Sommelier: close an owner inquiry and thank the owners who answered',
  description:
    'Closes an owner inquiry and REPLIES to every owner who answered it. Two texts, two audiences: `note` is the ' +
    'curator record the admin queue reads back (what the answers settled), `owner_reply` is read VERBATIM by the ' +
    'people who walked to their shelf and read the label for you — write it to them: what they told you, what it ' +
    'changed in the record, thanks. Fix the record FIRST (set_wine_profile / fix_pending_wine, or file a ' +
    'propose_wine_correction), then close. Omitting owner_reply still sends a plain thank-you — worse, but never ' +
    'silence, which is what an unanswered helper remembers. Owners who never answered are not notified. This ' +
    'notifies real people and is NOT reversible via undo_last (notifications cannot be unsent): confirm the ' +
    'wording with the somm first.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    inquiry_id: objectId.describe('From list_owner_inquiries'),
    note: z.string().min(NOTE_MIN).max(NOTE_MAX)
      .describe(`Curator record — what was done with the answers (${NOTE_MIN}–${NOTE_MAX} chars). NOT shown to owners.`),
    owner_reply: z.string().max(OWNER_REPLY_MAX).optional()
      .describe(`What the answering owners read, verbatim (plain text, max ${OWNER_REPLY_MAX} chars).`),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    const result = await resolveOwnerInquiry({
      inquiryId: args.inquiry_id,
      userId: ctx.user.id,
      note: args.note,
      ownerReply: args.owner_reply,
      via: 'mcp',
      req: ctx.req,
    });
    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', result.message + ' Find it with list_owner_inquiries.');
      if (result.code === 'conflict') return fail('conflict', result.message + ' Somebody else already handled it.');
      return fail('invalid_input', result.message);
    }

    const { inquiry, notified, replySent } = result;
    const label = [inquiry.wineDefinition?.producer, inquiry.wineDefinition?.name]
      .filter(Boolean).join(' — ') || 'the wine';
    const envelope = {
      summary: notified > 0
        ? `Inquiry on ${label} resolved — ${notified} owner(s) replied to`
        : `Inquiry on ${label} resolved — nobody had answered, so no owner was notified`,
      data: {
        inquiry_id: inquiry._id,
        status: inquiry.status,
        owners_notified: notified,
        reply_sent: replySent,
        acknowledgement_only: notified > 0 && !replySent,
        note: notified > 0
          ? 'The owners who answered have been notified in-app and can read this on their bottle page for 30 days. Not undoable — the notifications are already out.'
          : 'No owner had answered this inquiry, so there was nobody to reply to.',
      },
    };
    await logAction(ctx, {
      tool: 'resolve_owner_inquiry',
      action: 'somm_owner_inquiry_resolve',
      detail: { inquiryId: String(inquiry._id), notified, replied: !!replySent },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
