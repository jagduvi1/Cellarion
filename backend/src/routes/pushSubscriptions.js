const express = require('express');
const PushSubscription = require('../models/PushSubscription');
const { requireAuth } = require('../middleware/auth');

let webpush;
const VAPID_CONFIGURED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (VAPID_CONFIGURED) {
  webpush = require('web-push');
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@cellarion.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const router = express.Router();
router.use(requireAuth);

// GET /api/push-subscriptions/status — check current device + total device count
router.get('/status', async (req, res) => {
  try {
    const { endpoint } = req.query;
    const totalDevices = await PushSubscription.countDocuments({ user: req.user.id });
    let thisDeviceRegistered = false;
    if (endpoint) {
      const exists = await PushSubscription.exists({ user: req.user.id, endpoint: String(endpoint) });
      thisDeviceRegistered = !!exists;
    }
    res.json({ totalDevices, thisDeviceRegistered });
  } catch (err) {
    console.error('Push status error:', err);
    res.status(500).json({ error: 'Failed to check push status' });
  }
});

// POST /api/push-subscriptions/test — send a test push to a specific endpoint
router.post('/test', async (req, res) => {
  try {
    if (!VAPID_CONFIGURED) {
      return res.status(400).json({ error: 'Push notifications are not configured on this server' });
    }
    const { endpoint } = req.body;
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Endpoint is required' });
    }
    const sub = await PushSubscription.findOne({ user: req.user.id, endpoint: String(endpoint) });
    if (!sub) {
      return res.status(404).json({ error: 'This device is not registered for push notifications' });
    }
    const payload = JSON.stringify({
      title: 'Cellarion Test',
      message: 'Push notifications are working on this device!',
      tag: 'test'
    });
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await PushSubscription.deleteOne({ user: req.user.id, endpoint: String(req.body.endpoint) });
      return res.status(410).json({ error: 'Subscription expired. Please re-register this device.' });
    }
    console.error('Test push error:', err);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// POST /api/push-subscriptions — save a new push subscription
router.post('/', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || typeof endpoint !== 'string' || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription: endpoint and keys required' });
    }

    const safeEndpoint = String(endpoint);
    const safeKeys = { p256dh: String(keys.p256dh), auth: String(keys.auth) };

    await PushSubscription.findOneAndUpdate(
      { endpoint: safeEndpoint },
      { $set: { user: req.user.id, endpoint: safeEndpoint, keys: safeKeys } },
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
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    await PushSubscription.deleteOne({ user: req.user.id, endpoint: String(endpoint) });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete push subscription error:', err);
    res.status(500).json({ error: 'Failed to delete push subscription' });
  }
});

module.exports = router;
