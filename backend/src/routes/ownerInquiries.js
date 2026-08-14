/**
 * /api/owner-inquiries — the OWNER side of curator inquiries
 * (models/WineOwnerInquiry.js; asked via routes/admin/ownerInquiries.js or
 * the MCP tool ask_bottle_owner).
 *
 *   GET  /mine        — the caller's active inquiries (their recipient view):
 *                       question, wine, THEIR bottle and THEIR response state
 *                       only. Other recipients' identities and answers never
 *                       leave the server here — an owner must not learn who
 *                       else owns the wine (privacy). ?wine=<id> narrows to
 *                       one wine (what the BottleDetail card asks). Also
 *                       returns inquiries the caller ANSWERED that a curator
 *                       resolved within the last REPLY_VISIBLE_DAYS, carrying
 *                       `curatorReply` — closing the loop for the person who
 *                       went and read the label. The curator's own
 *                       `resolutionNote` is never projected here.
 *   POST /:id/respond — body { response } (1–1000 plain text). Recipient-only,
 *                       single-shot and immutable (second attempt → 409),
 *                       demo-blocked. First answer flips the inquiry to
 *                       'answered'; the asker is notified.
 *
 * Expired open inquiries are excluded query-time here (user paths run no
 * global writes); the curator queue reads run the closing sweep.
 */
const express = require('express');
const router = express.Router();
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const User = require('../models/User');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { createNotification } = require('../services/notifications');
const { logAudit } = require('../services/audit');
const { isValidId } = require('../utils/validation');
const { stripHtml } = require('../utils/sanitize');
const { REPLY_VISIBLE_DAYS } = require('../services/ownerInquiryOps');

const RESPONSE_MAX = 1000;

router.use(requireAuth);

// An inquiry a user may still see/answer: answered, or open and not expired.
const activeFor = (now) => ([
  { status: 'answered' },
  { status: 'open', expiresAt: { $gt: now } },
]);

// …plus, for READING only, recently resolved ones: an owner who answered gets
// the curator's reply back on the same card rather than watching the question
// silently disappear. Narrowed to answerers in the projection below — a
// recipient who ignored the question was never replied to.
const replyWindowFrom = (now) => new Date(now.getTime() - REPLY_VISIBLE_DAYS * 24 * 60 * 60 * 1000);
const visibleFor = (now) => ([
  ...activeFor(now),
  { status: 'resolved', resolvedAt: { $gt: replyWindowFrom(now) } },
]);

// GET /api/owner-inquiries/mine — the caller's recipient view
router.get('/mine', async (req, res) => {
  try {
    const filter = {
      'recipients.user': req.user.id,
      $or: visibleFor(new Date()),
    };
    // Optional wine scope — validated id or ignored (never a cast 500).
    const wine = typeof req.query.wine === 'string' ? req.query.wine : '';
    if (wine) {
      if (!isValidId(wine)) return res.json({ inquiries: [] });
      filter.wineDefinition = wine;
    }

    const rows = await WineOwnerInquiry.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('wineDefinition', 'name producer')
      .lean();

    // Privacy projection: ONLY the caller's own recipient entry leaves the
    // server — never the other recipients or their answers. `resolutionNote`
    // is absent BY DESIGN: it is the curator's private record, and only
    // `ownerReply` was written to be read here.
    const inquiries = rows
      // A resolved row is worth showing only to someone who answered it.
      .filter((i) => i.status !== 'resolved'
        || (i.recipients || []).some((r) => String(r.user) === String(req.user.id) && r.response))
      .map((i) => {
        const mine = (i.recipients || []).find((r) => String(r.user) === String(req.user.id));
        return {
          _id: i._id,
          status: i.status,
          question: i.question,
          wine: i.wineDefinition
            ? { _id: i.wineDefinition._id, name: i.wineDefinition.name, producer: i.wineDefinition.producer || null }
            : null,
          bottle: mine?.bottle || null,
          responded: !!mine?.response,
          myResponse: mine?.response || null,
          respondedAt: mine?.respondedAt || null,
          // Only set once a curator has resolved it — the reply the owner is owed.
          curatorReply: i.ownerReply || null,
          resolvedAt: i.resolvedAt || null,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt || null,
        };
      });

    res.json({ inquiries });
  } catch (err) {
    console.error('List my owner inquiries error:', err);
    res.status(500).json({ error: 'Failed to load owner inquiries' });
  }
});

// POST /api/owner-inquiries/:id/respond — one immutable answer per recipient
router.post('/:id/respond', requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    // Plain text only, bounded even after strip — the curator reads it
    // verbatim in the review queue.
    const response = stripHtml(typeof req.body?.response === 'string' ? req.body.response : '');
    if (!response) {
      return res.status(400).json({ error: 'A response is required' });
    }
    if (response.length > RESPONSE_MAX) {
      return res.status(400).json({ error: `Response must be at most ${RESPONSE_MAX} characters` });
    }

    // Atomic claim: recipient + no prior answer + inquiry still answerable,
    // in ONE filter — two concurrent submits can't both write, and the `$`
    // positional update targets exactly the caller's recipient entry.
    const now = new Date();
    const inquiry = await WineOwnerInquiry.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: activeFor(now),
        recipients: { $elemMatch: { user: req.user.id, response: null } },
      },
      { $set: { 'recipients.$.response': response, 'recipients.$.respondedAt': now, status: 'answered' } },
      { new: true }
    ).populate('wineDefinition', 'name producer');

    if (!inquiry) {
      // Diagnose the refusal for a useful status (the write already failed
      // atomically — these reads only pick the message).
      const existing = await WineOwnerInquiry.findById(req.params.id)
        .select('status expiresAt recipients')
        .lean();
      if (!existing) return res.status(404).json({ error: 'Inquiry not found' });
      const mine = (existing.recipients || []).find((r) => String(r.user) === String(req.user.id));
      if (!mine) return res.status(403).json({ error: 'This inquiry was not addressed to you' });
      if (mine.response) return res.status(409).json({ error: 'You already answered this inquiry — answers cannot be changed' });
      return res.status(409).json({ error: 'This inquiry is no longer open' });
    }

    // Notify the asker (best-effort — never blocks the answer). The admin
    // review queue lives on /admin/wines; a somm asker reads answers over
    // MCP instead, so their notification carries no link.
    if (inquiry.askedBy) {
      const label = [inquiry.wineDefinition?.producer, inquiry.wineDefinition?.name].filter(Boolean).join(' — ') || 'a wine';
      User.findById(inquiry.askedBy).select('roles').lean()
        .then((asker) => {
          const link = asker?.roles?.includes('admin') ? '/admin/wines' : null;
          return createNotification(
            inquiry.askedBy,
            'owner_inquiry_response',
            'A bottle owner answered your inquiry',
            `An owner of ${label} answered your question — it is waiting in the owner-inquiry queue.`,
            link,
            'community'
          );
        })
        .catch(() => {});
    }

    // Ids and lengths only — the answer text is the owner's data, not audit detail.
    logAudit(req, 'user.ownerInquiry.respond',
      { type: 'WineOwnerInquiry', id: inquiry._id },
      { wineDefinitionId: inquiry.wineDefinition?._id || inquiry.wineDefinition, responseLength: response.length });

    res.json({ message: 'Answer sent — thank you', status: inquiry.status });
  } catch (err) {
    console.error('Respond to owner inquiry error:', err);
    res.status(500).json({ error: 'Failed to send your answer' });
  }
});

module.exports = router;
