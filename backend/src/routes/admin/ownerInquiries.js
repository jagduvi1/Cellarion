/**
 * Owner inquiries — the curator→owner question channel for registry records
 * only a bottle's owner can settle (models/WineOwnerInquiry.js; created here
 * or over MCP via ask_bottle_owner, both through the shared
 * services/ownerInquiryOps.createOwnerInquiry).
 *
 * Default export, mounted at /api/admin/owner-inquiries (admin only):
 *   GET  /             — list, needs-attention-first (answered > open >
 *                        resolved/closed), paginated; ?status=open|answered|
 *                        active|decided. Rows carry the wine summary, the
 *                        question and the full recipient entries WITH user
 *                        emails — this is the one surface where identities
 *                        show, and it is admin-gated. Envelope: { inquiries,
 *                        total, page, pages, pendingCount, answeredCount }
 *                        (pendingCount = active, feeds the AdminWines badge).
 *   POST /:id/resolve  — body { note, ownerReply? } → 'resolved' via a
 *                        claim-style findOneAndUpdate, so a double-resolve is
 *                        a clean 409. `note` (5–500) is the CURATOR's record;
 *                        `ownerReply` (optional, ≤1000) is sent verbatim to
 *                        every owner who answered, and is the only one of the
 *                        two they ever see. Both run through the shared
 *                        services/ownerInquiryOps.resolveOwnerInquiry.
 *
 * Named export `wineInquiryRouter`, mounted at /api/admin/wines BEFORE the
 * admin-gated wines router (app.js — the /api/auth two-router pattern):
 *   POST /:id/owner-inquiry — admin OR somm (requireSommOrAdmin per route,
 *                        the somm wine-profile gating), body { question }.
 *                        201 + recipientCount; 409 open inquiry exists;
 *                        404 no wine; 400 bad question / no owners found.
 *
 * Query-filter values are always literals from static arrays — never raw
 * request input (CodeQL query-injection rule, wineProposals pattern).
 */
const express = require('express');
const WineOwnerInquiry = require('../../models/WineOwnerInquiry');
const { requireAuth, requireRole, requireSommOrAdmin } = require('../../middleware/auth');
const {
  createOwnerInquiry,
  resolveOwnerInquiry,
  sweepExpiredInquiries,
  queryInquiryPage,
} = require('../../services/ownerInquiryOps');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');

// Service error code → HTTP status for the create path (no_owners is a
// precondition failure, not a validation one, but 400 per the API contract).
const CREATE_STATUS = { invalid_input: 400, not_found: 404, no_owners: 400, conflict: 409 };
const RESOLVE_STATUS = { invalid_input: 400, not_found: 404, conflict: 409 };

// ── Create (somm OR admin) — mounted under /api/admin/wines ────────────────
const wineInquiryRouter = express.Router();

// POST /api/admin/wines/:id/owner-inquiry — ask the wine's bottle owners
wineInquiryRouter.post('/:id/owner-inquiry', requireAuth, requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const result = await createOwnerInquiry({
      wineId: req.params.id,
      userId: req.user.id,
      via: 'rest',
      question: req.body?.question,
      req,
    });
    if (!result.ok) {
      return res.status(CREATE_STATUS[result.code] || 400).json({ error: result.message });
    }

    res.status(201).json({
      message: `Inquiry sent to ${result.recipientCount} bottle owner(s)`,
      inquiry: {
        _id: result.inquiry._id,
        status: result.inquiry.status,
        question: result.inquiry.question,
        expiresAt: result.inquiry.expiresAt,
      },
      recipientCount: result.recipientCount,
      fallbackUsed: result.fallbackUsed,
    });
  } catch (err) {
    console.error('Create owner inquiry error:', err);
    res.status(500).json({ error: 'Failed to create owner inquiry' });
  }
});

// ── Review queue (admin only) — mounted at /api/admin/owner-inquiries ──────
const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// Keep in sync with the WineOwnerInquiry status enum. 'active' and 'decided'
// are list-only aliases (the review modal's two tabs).
const INQUIRY_STATUSES = ['open', 'answered', 'resolved', 'closed'];

// GET /api/admin/owner-inquiries — list, answered first (they need the admin),
// then open, then decided; newest first within rank
router.get('/', async (req, res) => {
  try {
    // Expired open inquiries leave the queue as 'closed' before it renders.
    await sweepExpiredInquiries();

    const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 200 });

    // Filter values come from static arrays, never from the request.
    const requested = String(req.query.status || '');
    const statusIdx = INQUIRY_STATUSES.indexOf(requested);
    const filter = {};
    if (statusIdx !== -1) {
      filter.status = INQUIRY_STATUSES[statusIdx];
    } else if (requested === 'active') {
      filter.status = { $in: [INQUIRY_STATUSES[0], INQUIRY_STATUSES[1]] };
    } else if (requested === 'decided') {
      filter.status = { $in: [INQUIRY_STATUSES[2], INQUIRY_STATUSES[3]] };
    }

    // Needs-attention-first ordering lives in the shared queryInquiryPage so
    // this list and the MCP list can never disagree.
    const { rows, total, pendingCount, answeredCount } = await queryInquiryPage(filter, { limit, offset });

    await WineOwnerInquiry.populate(rows, [
      { path: 'askedBy', select: 'username' },
      { path: 'resolvedBy', select: 'username' },
      // Emails are deliberately included HERE and nowhere else: the admin may
      // need to recognise/contact an owner; /mine and the MCP list never
      // expose recipient identities.
      { path: 'recipients.user', select: 'username email' },
      { path: 'wineDefinition', select: 'name producer appellation type' },
    ]);

    const inquiries = rows.map((i) => ({
      _id: i._id,
      status: i.status,
      question: i.question,
      askedBy: i.askedBy ? { _id: i.askedBy._id, username: i.askedBy.username } : null,
      askedVia: i.askedVia || 'rest',
      wineDefinition: i.wineDefinition
        ? {
          _id: i.wineDefinition._id,
          name: i.wineDefinition.name,
          producer: i.wineDefinition.producer || null,
          appellation: i.wineDefinition.appellation || null,
          type: i.wineDefinition.type || null,
        }
        : null,
      recipients: (i.recipients || []).map((r) => ({
        user: r.user ? { _id: r.user._id, username: r.user.username, email: r.user.email } : null,
        bottle: r.bottle || null,
        notifiedAt: r.notifiedAt || null,
        response: r.response || null,
        respondedAt: r.respondedAt || null,
      })),
      recipientCount: (i.recipients || []).length,
      responseCount: (i.recipients || []).filter((r) => r.response).length,
      resolvedBy: i.resolvedBy ? { _id: i.resolvedBy._id, username: i.resolvedBy.username } : null,
      resolvedAt: i.resolvedAt || null,
      resolutionNote: i.resolutionNote || null,
      // What was actually sent to the answering owners (null = they got the
      // plain thank-you, or nobody had answered).
      ownerReply: i.ownerReply || null,
      expiresAt: i.expiresAt || null,
      createdAt: i.createdAt,
    }));

    res.json({ inquiries, total, page, pages: Math.ceil(total / limit), pendingCount, answeredCount });
  } catch (err) {
    console.error('Admin list owner inquiries error:', err);
    res.status(500).json({ error: 'Failed to list owner inquiries' });
  }
});

// POST /api/admin/owner-inquiries/:id/resolve — note required, claim-style
router.post('/:id/resolve', async (req, res) => {
  try {
    // Validation, the atomic claim and the owner notification all live in the
    // shared service so this queue and the somm MCP tool cannot drift on what
    // the owners are told.
    const result = await resolveOwnerInquiry({
      inquiryId: req.params.id,
      userId: req.user.id,
      note: req.body?.note,
      ownerReply: req.body?.ownerReply,
      via: 'rest',
      req,
    });
    if (!result.ok) {
      return res.status(RESOLVE_STATUS[result.code] || 400).json({ error: result.message });
    }

    res.json({
      message: result.notified > 0
        ? `Inquiry resolved — ${result.notified} owner(s) notified`
        : 'Inquiry resolved',
      inquiryId: result.inquiry._id,
      status: 'resolved',
      notified: result.notified,
      replySent: result.replySent,
    });
  } catch (err) {
    console.error('Resolve owner inquiry error:', err);
    res.status(500).json({ error: 'Failed to resolve owner inquiry' });
  }
});

module.exports = router;
module.exports.wineInquiryRouter = wineInquiryRouter;
