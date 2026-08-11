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
 *   POST /:id/resolve  — note required (5–500) → 'resolved' via a claim-style
 *                        findOneAndUpdate, so a double-resolve is a clean 409.
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
const mongoose = require('mongoose');
const WineOwnerInquiry = require('../../models/WineOwnerInquiry');
const { requireAuth, requireRole, requireSommOrAdmin } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');
const { createOwnerInquiry, sweepExpiredInquiries, queryInquiryPage } = require('../../services/ownerInquiryOps');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');

const RESOLVE_NOTE_MIN = 5;
const RESOLVE_NOTE_MAX = 500;

// Service error code → HTTP status for the create path (no_owners is a
// precondition failure, not a validation one, but 400 per the API contract).
const CREATE_STATUS = { invalid_input: 400, not_found: 404, no_owners: 400, conflict: 409 };

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
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    // Plain text only, bounded even after strip (proposal-reject hygiene) —
    // the note is the record of what was done with the answers.
    const note = stripHtml(typeof req.body?.note === 'string' ? req.body.note : '');
    if (!note || note.length < RESOLVE_NOTE_MIN) {
      return res.status(400).json({ error: `A resolution note of at least ${RESOLVE_NOTE_MIN} characters is required — say what was done with the answers` });
    }
    if (note.length > RESOLVE_NOTE_MAX) {
      return res.status(400).json({ error: `Resolution note must be at most ${RESOLVE_NOTE_MAX} characters` });
    }

    // Atomic claim: only an active row can be resolved, so the second of two
    // concurrent resolves loses cleanly (the wineProposals decide pattern).
    const inquiryId = new mongoose.Types.ObjectId(req.params.id);
    const inquiry = await WineOwnerInquiry.findOneAndUpdate(
      { _id: inquiryId, status: { $in: ['open', 'answered'] } },
      { $set: { status: 'resolved', resolvedBy: req.user.id, resolvedAt: new Date(), resolutionNote: note } },
      { new: true }
    );
    if (!inquiry) {
      const exists = await WineOwnerInquiry.exists({ _id: inquiryId });
      return exists
        ? res.status(409).json({ error: 'Inquiry has already been resolved or closed' })
        : res.status(404).json({ error: 'Inquiry not found' });
    }

    logAudit(req, 'admin.wine.ownerInquiry.resolve',
      { type: 'WineOwnerInquiry', id: inquiry._id },
      {
        wineDefinitionId: inquiry.wineDefinition,
        responses: (inquiry.recipients || []).filter((r) => r.response).length,
        note,
      });

    res.json({ message: 'Inquiry resolved', inquiryId: inquiry._id, status: 'resolved' });
  } catch (err) {
    console.error('Resolve owner inquiry error:', err);
    res.status(500).json({ error: 'Failed to resolve owner inquiry' });
  }
});

module.exports = router;
module.exports.wineInquiryRouter = wineInquiryRouter;
