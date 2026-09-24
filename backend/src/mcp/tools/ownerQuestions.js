// Curator questions — the OWNER side of owner inquiries.
//
// A sommelier or admin asks a wine's bottle owners a record question they
// cannot settle from research ("what does the back label say the producer
// is?"; services/ownerInquiryOps, asked with ask_bottle_owner). Until now an
// owner could only answer from the bottle page, behind a notification that
// was easy to miss; over MCP the notification carried no inquiry id and
// get_bottle said nothing. These two tools put the question in front of the
// owner where they already talk about their bottles, and carry the answer
// back through the SAME service function the web card uses — so the privacy
// projection (only the caller's own recipient entry, never who else owns the
// wine) and the single-shot claim cannot fork between the two surfaces.
const { z } = require('zod');
const { registerTool } = require('../registry');
const { ok, fail, objectId } = require('../toolUtil');
const { logAction } = require('../actionLedger');
const {
  RESPONSE_MAX,
  listInquiriesForRecipient,
  respondToOwnerInquiry,
} = require('../../services/ownerInquiryOps');

const wineLabel = (w) => [w?.producer, w?.name].filter(Boolean).join(' — ') || 'the wine';

// The recipient view, in the tool's vocabulary. Nothing here is about any
// other recipient — the service already projected them away.
const serialize = (i) => ({
  inquiry_id: i._id,
  status: i.status,
  question: i.question,
  wine: i.wine ? { wine_id: i.wine._id, name: i.wine.name, producer: i.wine.producer || null } : null,
  // The bottle that made the user a recipient — where the web card renders.
  bottle_id: i.bottle,
  answered: i.responded,
  my_answer: i.myResponse,
  answered_at: i.respondedAt,
  // Set once a curator resolved the inquiry with a reply written to owners.
  curator_reply: i.curatorReply,
  resolved_at: i.resolvedAt,
  asked_at: i.createdAt,
  expires_at: i.expiresAt,
});

registerTool({
  name: 'list_curator_questions',
  title: 'Questions a curator asked about the user\'s wines',
  description:
    'Lists the questions Cellarion\'s sommelier/admin curators have sent THIS user about wines they own — record ' +
    'facts only the person holding the bottle can settle ("what does the back label say the producer is?", "is ' +
    'this the DOC or the DOCG bottling?"). Unanswered questions first, then answered ones (with the curator\'s reply ' +
    'once they resolved it). Call when list_notifications shows an owner_inquiry notification, when get_bottle ' +
    'returns open_curator_question, or when the user asks whether anyone needs something from them. Pass wine_id ' +
    'to check one wine. Answer with answer_curator_question. Other owners of the same wine are never shown here.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.optional().describe('Only questions about this registry wine'),
  },
  handler: async (args, ctx) => {
    const rows = await listInquiriesForRecipient(ctx.user.id, args.wine_id ? { wineId: args.wine_id } : {});
    // Unanswered first (stable — the service already sorted newest first).
    const ordered = [...rows.filter((r) => !r.responded), ...rows.filter((r) => r.responded)];
    const waiting = ordered.filter((r) => !r.responded).length;
    const replied = ordered.filter((r) => r.curatorReply).length;
    const summary = ordered.length === 0
      ? 'No curator questions for this user'
      : `${waiting} question(s) waiting for an answer, ${ordered.length - waiting} answered` +
        (replied ? ` (${replied} with a curator reply)` : '');
    return ok(summary, ordered.map(serialize), waiting > 0
      ? { warnings: ['Each question can be answered ONCE and the answer cannot be edited — read it back to the user before sending.'] }
      : {});
  },
});

registerTool({
  name: 'answer_curator_question',
  title: 'Answer a curator\'s question about one of the user\'s wines',
  description:
    'Sends the user\'s answer to a curator question from list_curator_questions (or get_bottle → ' +
    'open_curator_question). The answer is what the user can see on the bottle in their hand — transcribe the ' +
    'label as they read it out, do not add your own guesses. ONE answer per question, IMMUTABLE and NOT undoable: ' +
    'a real curator reads it verbatim, so confirm the exact wording with the user first. When the curator resolves ' +
    'the question, their reply arrives as a notification and in list_curator_questions. A conflict answer means ' +
    'the question was already answered or has closed — nothing to resend.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    inquiry_id: objectId.describe('From list_curator_questions / get_bottle → open_curator_question'),
    answer: z.string().min(1).max(RESPONSE_MAX)
      .describe(`The user\'s answer, verbatim (plain text, max ${RESPONSE_MAX} chars; HTML is stripped)`),
  },
  handler: async (args, ctx) => {
    // ONE implementation with the web card's respond route — identical claim,
    // refusal diagnosis, asker notification and audit string (via:'mcp').
    const result = await respondToOwnerInquiry({
      inquiryId: args.inquiry_id,
      userId: ctx.user.id,
      response: args.answer,
      via: 'mcp',
      req: ctx.req,
    });
    if (!result.ok) {
      // A question that exists but was addressed to someone else is reported
      // exactly like one that does not exist: this surface never confirms
      // what other owners were asked.
      if (result.code === 'not_found' || result.code === 'forbidden') {
        return fail('not_found', 'No curator question with that id is addressed to this user — list_curator_questions shows theirs.');
      }
      if (result.code === 'conflict') return fail('conflict', `${result.message}. Nothing to resend.`);
      return fail('invalid_input', result.message);
    }

    const { inquiry } = result;
    const wineId = inquiry.wineDefinition?._id || inquiry.wineDefinition || null;
    const envelope = {
      summary: `Answer sent to the curator about ${wineLabel(inquiry.wineDefinition)}`,
      data: {
        inquiry_id: inquiry._id,
        wine_id: wineId,
        status: inquiry.status,
        note: 'The curator reads the answer in their queue; it cannot be changed or withdrawn. Their reply, once they resolve the question, shows in list_curator_questions and as a notification.',
      },
    };
    // Ledger row for the activity timeline — not undo-eligible (revert.js
    // never selects this action): the answer is single-shot on the inquiry.
    // The text itself is the owner's correspondence, not ledger detail.
    await logAction(ctx, {
      tool: 'answer_curator_question',
      action: 'inquiry_answer',
      detail: { inquiryId: String(inquiry._id), wineId: wineId ? String(wineId) : null, answerLength: args.answer.length },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
