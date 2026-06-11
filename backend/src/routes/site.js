const express = require('express');
const announcementConfig = require('../config/announcement');

const router = express.Router();

// GET /api/site/announcement — public, read-only. Every client checks this
// for the SuperAdmin-managed banner (e.g. planned-maintenance notices), so
// it must stay cheap: in-memory config, 60s edge/browser cache.
router.get('/announcement', (req, res) => {
  const a = announcementConfig.get();
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (!a.enabled) return res.json({ enabled: false });
  res.json(a);
});

module.exports = router;
