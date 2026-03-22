const express = require('express');
const router = express.Router();
const SupportTicket = require('../models/SupportTicket');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/audit');

const VALID_CATEGORIES = ['bug', 'help', 'feature', 'other'];

// POST /api/support — submit a support ticket
router.post('/', requireAuth, async (req, res) => {
  const { category, subject, message } = req.body;

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: 'Subject is required' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (subject.trim().length > 200) {
    return res.status(400).json({ error: 'Subject must be 200 characters or fewer' });
  }
  if (message.trim().length > 5000) {
    return res.status(400).json({ error: 'Message must be 5000 characters or fewer' });
  }

  const ticket = await SupportTicket.create({
    user: req.user.id,
    category,
    subject: subject.trim(),
    message: message.trim()
  });

  logAudit(req, 'support.ticket.created', { type: 'SupportTicket', id: ticket._id }, {
    category,
    subject: subject.trim()
  });

  res.status(201).json({ ticket });
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
