// User-data registry entries: what a member asked of the people who run the
// registry. Wine requests, wine reports, correction proposals, questions to
// bottle owners and support tickets.
// One part of the REGISTRY of services/userDataRegistry.js, which documents the
// entry shape and runs the entries in order.

const SupportTicket = require('../../models/SupportTicket');
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const WineOwnerInquiry = require('../../models/WineOwnerInquiry');
const WineReport = require('../../models/WineReport');
const WineRequest = require('../../models/WineRequest');
const { EXPORT_MAX, markTrunc } = require('./shared');

module.exports = [
  // ── Requests & reports ──────────────────────────────────────────────────
  {
    model: WineRequest, category: 'shared-content', userFields: ['user', 'resolvedBy'],
    purge: (ctx) => [
      WineRequest.deleteMany({ user: ctx.userId }),
      WineRequest.updateMany({ resolvedBy: ctx.userId }, { $unset: { resolvedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({ wineRequests: markTrunc(ctx, 'wineRequests', await WineRequest.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: WineReport, category: 'shared-content', userFields: ['user', 'resolvedBy'],
    purge: (ctx) => [
      WineReport.deleteMany({ user: ctx.userId }),
      WineReport.updateMany({ resolvedBy: ctx.userId }, { $unset: { resolvedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({
      // details/suggestedField/suggestedValue are text the USER typed —
      // portability requires they come back out (audit 2026-07-29 M1).
      // adminResponse is our reply TO them: already shown on their Support
      // page, so it is part of the record they hold, not internal commentary.
      reports: { wines: markTrunc(ctx, 'wineReports', await WineReport.find({ user: ctx.userId }).select('wineDefinition reason status createdAt details suggestedField suggestedValue adminResponse respondedAt').limit(EXPORT_MAX).lean())
        .map(r => ({ reason: r.reason, status: r.status, createdAt: r.createdAt, details: r.details, suggestedField: r.suggestedField, suggestedValue: r.suggestedValue, adminResponse: r.adminResponse, respondedAt: r.respondedAt })) },
    }),
  },
  {
    // Same policy as WineReport (the closest sibling — user-authored rows
    // about shared registry wines): the proposer's rows are hard-deleted; the
    // departing user's ADMIN ref (decidedBy) is cleared off other users'
    // decided proposals so it doesn't dangle.
    model: WineCorrectionProposal, category: 'shared-content', userFields: ['proposer', 'decidedBy'],
    purge: (ctx) => [
      WineCorrectionProposal.deleteMany({ proposer: ctx.userId }),
      WineCorrectionProposal.updateMany({ decidedBy: ctx.userId }, { $unset: { decidedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({
      // reason/proposedFields/evidenceUrl are text the USER typed —
      // portability requires they come back out (the WineReport precedent,
      // audit 2026-07-29 M1). The wine label comes from the propose-time
      // snapshot so it survives the wine being merged away or renamed.
      wineCorrectionProposals: markTrunc(ctx, 'wineCorrectionProposals',
        await WineCorrectionProposal.find({ proposer: ctx.userId })
          .select('kind currentSnapshot proposedFields reason evidenceUrl amendments status rejectReason appliedNote createdAt decidedAt')
          .limit(EXPORT_MAX).lean())
        .map(p => ({
          kind: p.kind,
          wine: [p.currentSnapshot?.producer, p.currentSnapshot?.name].filter(Boolean).join(' — ') || null,
          proposedFields: p.proposedFields || null,
          reason: p.reason,
          evidenceUrl: p.evidenceUrl || null,
          // Later filings on the same pending suggestion: each carries a reason
          // and an evidence link the USER typed. `amendments` was selected but
          // never mapped, so they never came back out — and since the bottle
          // page files one field at a time, fixing a second field IS an
          // amendment: the normal path, not an edge (pre-deploy audit 2026-09-18).
          amendments: (p.amendments || []).map(a => ({
            at: a.at || null,
            fields: a.fields || [],
            reason: a.reason,
            evidenceUrl: a.evidenceUrl || null,
          })),
          status: p.status,
          // The outcome, as the sibling queues export it (what a curator wrote
          // about the submission, and what an approval actually applied).
          rejectReason: p.rejectReason || null,
          appliedNote: p.appliedNote || null,
          createdAt: p.createdAt,
          decidedAt: p.decidedAt || null,
        })),
    }),
  },
  {
    // Owner inquiries are multi-party (one question, up to 20 recipients), so
    // erasure is surgical: the departing user's RECIPIENT entry (their answer
    // included) is pulled while the question stays for the other recipients;
    // an inquiry left with no recipients is closed in postPurge (nobody can
    // answer it any more — the PriceTrackingRequest orphan pattern). Their
    // ASKED inquiries keep the question for the queue with askedBy nulled
    // (the schema is nullable for exactly this), and their admin ref
    // (resolvedBy) is cleared off other users' resolved inquiries.
    model: WineOwnerInquiry, category: 'shared-content', userFields: ['askedBy', 'recipients.user', 'resolvedBy'],
    purge: (ctx) => [
      WineOwnerInquiry.updateMany({ 'recipients.user': ctx.userId }, { $pull: { recipients: { user: ctx.userId } } }),
      WineOwnerInquiry.updateMany({ askedBy: ctx.userId }, { $set: { askedBy: null } }),
      WineOwnerInquiry.updateMany({ resolvedBy: ctx.userId }, { $unset: { resolvedBy: '' } }),
    ],
    postPurge: () => WineOwnerInquiry.updateMany(
      { recipients: { $size: 0 }, status: { $in: ['open', 'answered'] } },
      { $set: {
        status: 'closed',
        resolvedAt: new Date(),
        resolutionNote: 'Closed automatically: no recipients remain to answer.',
      } }
    ),
    exportFragment: async (ctx) => {
      // Both sides are the user's data: answers they wrote as a recipient
      // (with the question + wine label for context) and questions they asked
      // as a curator. Never other recipients' entries.
      const [received, asked] = await Promise.all([
        WineOwnerInquiry.find({ 'recipients.user': ctx.userId })
          // ownerReply is correspondence SENT TO them — theirs to export.
          // resolutionNote is not: it is the curator's private record.
          .select('question status recipients ownerReply createdAt resolvedAt')
          .populate('wineDefinition', 'name producer')
          .limit(EXPORT_MAX).lean(),
        WineOwnerInquiry.find({ askedBy: ctx.userId })
          .select('question status resolutionNote ownerReply createdAt resolvedAt')
          .populate('wineDefinition', 'name producer')
          .limit(EXPORT_MAX).lean(),
      ]);
      markTrunc(ctx, 'ownerInquiriesReceived', received);
      markTrunc(ctx, 'ownerInquiriesAsked', asked);
      const label = (i) => [i.wineDefinition?.producer, i.wineDefinition?.name].filter(Boolean).join(' — ') || null;
      return {
        ownerInquiries: {
          received: received.map((i) => {
            const mine = (i.recipients || []).find((r) => (r.user?.toString?.() || r.user) === ctx.userId);
            return {
              wine: label(i),
              question: i.question,
              status: i.status,
              myResponse: mine?.response || null,
              respondedAt: mine?.respondedAt || null,
              notifiedAt: mine?.notifiedAt || null,
              // When the question was also emailed to them (ownerInquiryEmail).
              emailedAt: mine?.emailedAt || null,
              // Only reaches them if they answered — same rule as the card.
              curatorReply: (mine?.response && i.ownerReply) || null,
              createdAt: i.createdAt,
              resolvedAt: i.resolvedAt || null,
            };
          }),
          asked: asked.map((i) => ({
            wine: label(i),
            question: i.question,
            status: i.status,
            resolutionNote: i.resolutionNote || null,
            ownerReply: i.ownerReply || null,
            createdAt: i.createdAt,
            resolvedAt: i.resolvedAt || null,
          })),
        },
      };
    },
  },
  {
    model: SupportTicket, category: 'personal-data', userFields: ['user', 'respondedBy', 'replies.by'],
    purge: (ctx) => [
      SupportTicket.deleteMany({ user: ctx.userId }),
      // Clear this user's staff ref off OTHER users' tickets.
      SupportTicket.updateMany({ respondedBy: ctx.userId }, { $unset: { respondedBy: '' } }),
      // Same for thread entries this user (as an admin) wrote on OTHER users'
      // tickets: replies[].by is required, so re-point it to the [deleted]
      // sentinel (the taxonomy-createdBy convention) instead of unsetting.
      SupportTicket.updateMany(
        { 'replies.by': ctx.userId },
        { $set: { 'replies.$[el].by': ctx.deletedUserId } },
        { arrayFilters: [{ 'el.by': ctx.userId }] }
      ),
    ],
    exportFragment: async (ctx) => ({
      supportTickets: markTrunc(ctx, 'supportTickets', await SupportTicket.find({ user: ctx.userId }).select('category feature subject message status adminResponse respondedAt replies createdAt').limit(EXPORT_MAX).lean())
        .map(t => ({ category: t.category, ...(t.feature ? { feature: t.feature } : {}), subject: t.subject, message: t.message, status: t.status, adminResponse: t.adminResponse, respondedAt: t.respondedAt, createdAt: t.createdAt,
          // The conversation, without the by refs (an admin's account id is
          // not the exporting user's data — author side + text suffice).
          replies: (t.replies || []).map(r => ({ author: r.author, message: r.message, createdAt: r.createdAt })) })),
    }),
  },
];
