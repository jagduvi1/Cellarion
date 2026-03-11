const express = require('express');
const router = express.Router();
const SupportTicket = require('../../models/SupportTicket');
const Notification = require('../../models/Notification');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/support-tickets — list all tickets with optional status filter
router.get('/', async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (status) filter.status = status;

  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('user', 'username email')
      .populate('respondedBy', 'username')
      .lean(),
    SupportTicket.countDocuments(filter)
  ]);

  res.json({ tickets, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/admin/support-tickets/:id — get single ticket
router.get('/:id', async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id)
    .populate('user', 'username email')
    .populate('respondedBy', 'username')
    .lean();

  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket });
});

// PUT /api/admin/support-tickets/:id/respond — respond to a ticket
router.put('/:id/respond', async (req, res) => {
  const { adminResponse, status } = req.body;

  if (!adminResponse || !adminResponse.trim()) {
    return res.status(400).json({ error: 'Response message is required' });
  }

  const allowedStatuses = ['open', 'in_progress', 'closed'];
  const newStatus = allowedStatuses.includes(status) ? status : 'in_progress';

  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticket.adminResponse = adminResponse.trim();
  ticket.respondedBy = req.user.id;
  ticket.respondedAt = new Date();
  ticket.status = newStatus;
  await ticket.save();

  // Notify the user
  await Notification.create({
    user: ticket.user,
    type: 'support_ticket_response',
    title: 'Support ticket update',
    message: `Your support ticket "${ticket.subject}" has received a response.`,
    link: '/support'
  });

  logAudit(req, 'support.ticket.responded', { type: 'SupportTicket', id: ticket._id }, {
    status: newStatus
  });

  await ticket.populate('user', 'username email');
  await ticket.populate('respondedBy', 'username');
  res.json({ ticket });
});

// PUT /api/admin/support-tickets/:id/status — update ticket status only
router.put('/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowedStatuses = ['open', 'in_progress', 'closed'];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const ticket = await SupportTicket.findByIdAndUpdate(
    req.params.id,
    { status, updatedAt: new Date() },
    { new: true }
  )
    .populate('user', 'username email')
    .populate('respondedBy', 'username');

  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  logAudit(req, 'support.ticket.status_changed', { type: 'SupportTicket', id: ticket._id }, { status });

  res.json({ ticket });
});

module.exports = router;
