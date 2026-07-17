const express = require('express');
const router = express.Router();
const SupportTicket = require('../models/SupportTicket');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { createSupportTicket, replyToTicket } = require('../services/accountOps');

// POST /api/support — submit a support ticket
// requireNonDemo: support tickets land in the admin queue and would waste admin
// attention on a throwaway account that's gone before anyone replies.
router.post('/', requireAuth, requireNonDemo, async (req, res) => {
  try {
    // Validation + creation shared with the MCP create_support_ticket tool.
    const { ticket, error } = await createSupportTicket(req.user.id, req.body || {});
    if (error) return res.status(error.status).json({ error: error.message });

    logAudit(req, 'support.ticket.created', { type: 'SupportTicket', id: ticket._id }, {
      category: ticket.category,
      subject: String(req.body.subject).trim()
    });

    res.status(201).json({ ticket });
  } catch (err) {
    console.error('Create support ticket error:', err);
    res.status(500).json({ error: 'Failed to submit support ticket' });
  }
});

// POST /api/support/:id/reply — follow up on the caller's own ticket.
// Validation + append shared with the MCP reply_to_ticket tool; a user reply
// flips the ticket back to 'open' so it resurfaces in the admin queue.
// requireNonDemo for the same reason as ticket creation above.
router.post('/:id/reply', requireAuth, requireNonDemo, async (req, res) => {
  try {
    const { ticket, error } = await replyToTicket(req.user.id, req.params.id, (req.body || {}).message);
    if (error) return res.status(error.status).json({ error: error.message });

    logAudit(req, 'support.ticket.replied', { type: 'SupportTicket', id: ticket._id }, {
      replies: ticket.replies.length
    });

    res.json({ ticket });
  } catch (err) {
    console.error('Reply to support ticket error:', err);
    res.status(500).json({ error: 'Failed to reply to support ticket' });
  }
});

// GET /api/support/my — list the authenticated user's own tickets
router.get('/my', requireAuth, async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .populate('respondedBy', 'username')
      .lean();

    res.json({ tickets });
  } catch (err) {
    console.error('Get my support tickets error:', err);
    res.status(500).json({ error: 'Failed to get support tickets' });
  }
});

module.exports = router;
