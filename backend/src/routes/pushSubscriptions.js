const express = require('express');
const PushSubscription = require('../models/PushSubscription');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// POST /api/push-subscriptions — save a new push subscription
router.post('/', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription: endpoint and keys required' });
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { $set: { user: req.user.id, endpoint, keys } },
      { upsert: true, new: true }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Save push subscription error:', err);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

// DELETE /api/push-subscriptions — remove a push subscription by endpoint
router.delete('/', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    await PushSubscription.deleteOne({ user: req.user.id, endpoint });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete push subscription error:', err);
    res.status(500).json({ error: 'Failed to delete push subscription' });
  }
});

module.exports = router;
