const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { requireAuth } = require('../middleware/auth');
const { isValidId } = require('../utils/validation');
const { getNotificationsVersion, bumpNotificationsVersion } = require('../services/dataVersion');
const { createTokenReadCache } = require('../services/tokenReadCache');

// All routes require auth
router.use(requireAuth);

// Machine polling (usage check 2026-10-09): the Home Assistant integration
// asks for the list every few minutes per install — about 2,200 reads a day
// from some thirty installs, two database queries each, and the integration
// runs on about one active user in four, so the reads grow with the users.
// API-token requests are answered from memory while the user's notifications
// version (services/dataVersion) is unchanged: services/notifications moves
// it for every recipient of a new row, and the two mark-read routes below
// move it for the reader. Its own version, not the data version, so marking
// a notification read never makes the next poll recompute the statistics.
// The max age is short because rows also leave through the TTL index, which
// nothing announces. Browser requests are never cached.
const tokenCache = createTokenReadCache({ maxAgeMs: 10 * 60 * 1000 });

// GET /api/notifications - fetch the 30 most recent notifications for the current user
router.get('/', async (req, res) => {
  try {
    // Read the version BEFORE loading: a row inserted during the load moves
    // it on, so the entry stored below can never outlive that row.
    const version = req.apiToken ? getNotificationsVersion(req.user.id) : null;
    if (req.apiToken) {
      const hit = tokenCache.get(req.user.id, 'list', version);
      if (hit) return res.json(hit);
    }

    const [notifications, unreadCount] = await Promise.all([
      // _id breaks ties between rows created in the same millisecond (a burst
      // of notifications), so the order — and the probe's newestId below — is
      // stable between reads (release audit 2026-09-27, L).
      Notification.find({ user: req.user.id })
        .sort({ createdAt: -1, _id: -1 })
        .limit(30)
        .lean(),
      // Count across ALL rows, not just the returned page — older unread
      // notifications outside the 30 most recent still count.
      Notification.countDocuments({ user: req.user.id, read: false }),
    ]);

    const body = { notifications, unreadCount };
    if (req.apiToken) tokenCache.set(req.user.id, 'list', version, body);
    res.json(body);
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
    const version = req.apiToken ? getNotificationsVersion(req.user.id) : null;
    if (req.apiToken) {
      const hit = tokenCache.get(req.user.id, 'probe', version);
      if (hit) return res.json(hit);
    }

    const [unreadCount, newest] = await Promise.all([
      Notification.countDocuments({ user: req.user.id, read: false }),
      Notification.findOne({ user: req.user.id })
        .sort({ createdAt: -1, _id: -1 })
        .select('_id')
        .lean(),
    ]);

    const body = { unreadCount, newestId: newest ? String(newest._id) : null };
    if (req.apiToken) tokenCache.set(req.user.id, 'probe', version, body);
    res.json(body);
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
    bumpNotificationsVersion(req.user.id);
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
    bumpNotificationsVersion(req.user.id);
    res.json({ notification });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

module.exports = router;
