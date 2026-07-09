const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const RestockAlert = require('../models/RestockAlert');

const router = express.Router();
router.use(requireAuth);

// GET /api/restock-alerts — list active restock alerts for the current user
router.get('/', async (req, res) => {
  try {
    const VALID_STATUSES = ['active', 'dismissed', 'resolved'];
    const requestedStatus = String(req.query.status || 'active');
    // 400 on unknown values ('all' is the explicit everything selector) —
    // a typo used to silently return every status mixed together.
    if (requestedStatus !== 'all' && !VALID_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}, all` });
    }
    const query = { user: req.user.id };
    if (requestedStatus !== 'all') {
      query.status = VALID_STATUSES.find(s => s === requestedStatus);
    }

    const alerts = await RestockAlert.find(query)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({ alerts });
  } catch (err) {
    console.error('Get restock alerts error:', err);
    res.status(500).json({ error: 'Failed to load restock alerts' });
  }
});

// PUT /api/restock-alerts/:id/dismiss — dismiss an alert
router.put('/:id/dismiss', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'Invalid ID' });

    const alert = await RestockAlert.findOneAndUpdate(
      { _id: id, user: req.user.id, status: 'active' },
      { status: 'dismissed', dismissedAt: new Date() },
      { new: true }
    ).lean();

    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    res.json({ alert });
  } catch (err) {
    console.error('Dismiss restock alert error:', err);
    res.status(500).json({ error: 'Failed to dismiss alert' });
  }
});

module.exports = router;
