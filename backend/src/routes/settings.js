const express = require('express');
const SiteConfig = require('../models/SiteConfig');

const router = express.Router();

// GET /api/settings — publicly readable site settings
router.get('/', async (req, res) => {
  try {
    const doc = await SiteConfig.findOne({ key: 'contactEmail' }).lean();
    res.json({
      contactEmail: doc?.value ?? null,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null
    });
  } catch (err) {
    console.error('Public settings error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

module.exports = router;
