// Sommelier tools: wine reports — the defect reports members file against
// registry wines, and the somm's answer that closes them.
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const mongoose = require('mongoose');
const WineReport = require('../../../models/WineReport');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, pageParams, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAction } = require('../../actionLedger');
const { closeWineReport, MAX_RESPONSE } = require('../../../services/wineReportOps');
const { wineLite } = require('./shared');

// ── Wine reports (user-filed defect reports) ─────────────────────────────────
//
// A report is a real person saying "this record is wrong" about a wine they
// own. Both tools ride services/wineReportOps so the somm surface and the
// admin REST queue cannot drift on what the reporter is told.
//
// Deliberately NOT here: applying the report's structured suggestion to the
// registry. That is an identity write, and the somm's route for identity is
// propose_wine_correction (propose, admin approves). Answering the reporter
// and closing the report is squarely somm work — the questions are usually
// maturity and profile ones the somm can already fix directly.
//
// ANONYMISED like the owner inquiries: the somm gets the report and the wine,
// never the reporter's identity.
const REPORT_STATUS_FILTERS = ['pending', 'resolved', 'dismissed', 'all'];
const REPORT_REASON_FILTERS = ['wrong_info', 'duplicate', 'inappropriate', 'wrong_price', 'wrong_tasting_profile', 'other'];

registerTool({
  name: 'list_wine_reports',
  title: 'Sommelier: list wine reports filed by users',
  description:
    'Lists defect reports users filed against registry wines ("wrong info", "wrong tasting profile", "wrong price", ' +
    'duplicate…) — the queue of records a bottle owner says are wrong. Oldest pending first: these people are ' +
    'waiting. Each row carries the reporter\'s own words, the wine as it stands now, and any structured correction ' +
    'they suggested. Reporters are ANONYMISED ("reporter") — judge the report on its content. Pass status to widen ' +
    'past the default "pending", reason to narrow to one class, wine_id for one wine. Close a report with ' +
    'respond_to_wine_report.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(REPORT_STATUS_FILTERS).optional().describe('Default "pending"'),
    reason: z.enum(REPORT_REASON_FILTERS).optional().describe('Narrow to one report class'),
    wine_id: objectId.optional().describe('Scope to one registry wine'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);

    // Filter values come from the static arrays, never raw input.
    const status = REPORT_STATUS_FILTERS.includes(args.status) ? args.status : 'pending';
    const filter = {};
    if (status !== 'all') filter.status = status;
    if (REPORT_REASON_FILTERS.includes(args.reason)) filter.reason = args.reason;
    if (args.wine_id) filter.wineDefinition = new mongoose.Types.ObjectId(args.wine_id);

    const [rows, total, pendingCount] = await Promise.all([
      WineReport.find(filter)
        // Oldest first while pending — a report that has waited longest is the
        // one most likely to have been forgotten. Newest first once closed.
        .sort(status === 'pending' ? { createdAt: 1 } : { createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate({ path: 'wineDefinition', select: 'name producer type appellation', populate: ['country', 'region'] })
        .populate('duplicateOf', 'name producer')
        .lean(),
      WineReport.countDocuments(filter),
      WineReport.countDocuments({ status: 'pending' }),
    ]);

    const data = rows.map((r) => ({
      report_id: r._id,
      wine: wineLite(r.wineDefinition),
      reason: r.reason,
      // The reporter's own words — the whole point of reading the queue.
      details: r.details || null,
      suggested_correction: r.suggestedField
        ? {
          field: r.suggestedField,
          current: r.wineDefinition?.[r.suggestedField] ?? null,
          proposed: r.suggestedValue,
          note: 'Applying an identity field is an admin step — file it with propose_wine_correction if you agree.',
        }
        : null,
      duplicate_of: r.duplicateOf
        ? { wine_id: r.duplicateOf._id, name: r.duplicateOf.name, producer: r.duplicateOf.producer || null }
        : null,
      status: r.status,
      reported_at: r.createdAt,
      response_sent: r.adminResponse || null,
      responded_at: r.respondedAt || null,
    }));

    return ok(
      `${pendingCount} report(s) awaiting review (showing ${data.length} of ${total} ${status})`,
      data,
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'respond_to_wine_report',
  title: 'Sommelier: answer a wine report and close it',
  description:
    'Closes a pending wine report and NOTIFIES the person who filed it. outcome "resolved" = the report was right ' +
    'and the record has been dealt with (fix the record FIRST with set_vintage_maturity / set_wine_profile, or file ' +
    'a propose_wine_correction, then close); "dismissed" = the record stands as it is. The response is read ' +
    'VERBATIM by a real user, so write it to them, not about them: say what you checked, what changed, and why. ' +
    'Omit it and they get a plain acknowledgement — worse, but never silence. This notifies a real person and is ' +
    'NOT reversible via undo_last (notifications cannot be unsent): confirm the wording with the somm first.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    report_id: objectId.describe('From list_wine_reports'),
    outcome: z.enum(['resolved', 'dismissed'])
      .describe('"resolved" = report was right and handled; "dismissed" = record stands'),
    response: z.string().max(MAX_RESPONSE).optional()
      .describe(`What the reporter reads, verbatim (plain text, max ${MAX_RESPONSE} chars). Leave empty only when there is genuinely nothing to say.`),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    const result = await closeWineReport({
      reportId: args.report_id,
      actorId: ctx.user.id,
      outcome: args.outcome,
      response: args.response,
      req: ctx.req,
      via: 'mcp',
    });
    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', result.message + ' Find it with list_wine_reports.');
      if (result.code === 'conflict') return fail('conflict', result.message + ' Somebody else already handled it.');
      return fail('invalid_input', result.message);
    }

    const report = result.report;
    const label = report.wineDefinition
      ? [report.wineDefinition.producer, report.wineDefinition.name].filter(Boolean).join(' — ')
      : 'the reported wine';
    const envelope = {
      summary: `Report on ${label} ${args.outcome} — reporter notified`,
      data: {
        report_id: report._id,
        status: report.status,
        response_sent: report.adminResponse || null,
        acknowledgement_only: !report.adminResponse,
        note: 'The reporter has been notified in-app and can read this on their Support page. Not undoable — the notification is already out.',
      },
    };
    await logAction(ctx, {
      tool: 'respond_to_wine_report',
      action: 'somm_wine_report_close',
      detail: { reportId: String(report._id), outcome: args.outcome, responded: !!report.adminResponse },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
