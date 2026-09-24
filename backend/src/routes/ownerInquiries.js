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
 * Both are thin over services/ownerInquiryOps (listInquiriesForRecipient,
 * respondToOwnerInquiry): the MCP tools list_curator_questions and
 * answer_curator_question read and write through the same functions, so
 * the privacy projection and the claim semantics cannot fork between the
 * web card and a user's AI assistant. Expired open inquiries are excluded
 * query-time there (user paths run no global writes); the curator queue
 * reads run the closing sweep.
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { isValidId } = require('../utils/validation');
const { listInquiriesForRecipient, respondToOwnerInquiry } = require('../services/ownerInquiryOps');

router.use(requireAuth);

// GET /api/owner-inquiries/mine — the caller's recipient view
router.get('/mine', async (req, res) => {
  try {
    // Optional wine scope — validated id or ignored (never a cast 500).
    const wine = typeof req.query.wine === 'string' ? req.query.wine : '';
    if (wine && !isValidId(wine)) return res.json({ inquiries: [] });
    const inquiries = await listInquiriesForRecipient(req.user.id, wine ? { wineId: wine } : {});
    res.json({ inquiries });
  } catch (err) {
    console.error('List my owner inquiries error:', err);
    res.status(500).json({ error: 'Failed to load owner inquiries' });
  }
});

// The service's transport-neutral refusal codes → HTTP statuses.
const RESPOND_STATUS = { invalid_input: 400, not_found: 404, forbidden: 403, conflict: 409 };

// POST /api/owner-inquiries/:id/respond — one immutable answer per recipient
router.post('/:id/respond', requireNonDemo, async (req, res) => {
  try {
    const result = await respondToOwnerInquiry({
      inquiryId: req.params.id,
      userId: req.user.id,
      response: req.body?.response,
      via: 'rest',
      req,
    });
    if (!result.ok) {
      return res.status(RESPOND_STATUS[result.code] || 400).json({ error: result.message });
    }
    res.json({ message: 'Answer sent — thank you', status: result.status });
  } catch (err) {
    console.error('Respond to owner inquiry error:', err);
    res.status(500).json({ error: 'Failed to send your answer' });
  }
});

module.exports = router;
