const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { requireAuth } = require('../middleware/auth');
const { isValidId } = require('../utils/validation');

// All routes require auth
router.use(requireAuth);

// GET /api/notifications - fetch the 30 most recent notifications for the current user
router.get('/', async (req, res) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ user: req.user.id })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
      // Count across ALL rows, not just the returned page — older unread
      // notifications outside the 30 most recent still count.
      Notification.countDocuments({ user: req.user.id, read: false }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// GET /api/notifications/unread-count - lightweight probe. The client asks
// this instead of the full list: the unread count for the badge, plus the id
// of the newest notification. The id is what lets the client tell that the
// list changed while the count stayed the same (one read on another device
// while a new one arrives), so it can skip the list fetch when nothing did.
// newestId uses the same index and sort as the list above, so it matches the
// first row the list returns.
router.get('/unread-count', async (req, res) => {
  try {
    const [unreadCount, newest] = await Promise.all([
      Notification.countDocuments({ user: req.user.id, read: false }),
      Notification.findOne({ user: req.user.id })
        .sort({ createdAt: -1 })
        .select('_id')
        .lean(),
    ]);
    res.json({ unreadCount, newestId: newest ? String(newest._id) : null });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// PUT /api/notifications/read-all - mark all notifications as read
router.put('/read-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user.id, read: false },
      { read: true }
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// PUT /api/notifications/:id/read - mark a single notification as read
router.put('/:id/read', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ notification });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

module.exports = router;
