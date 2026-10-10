const express = require('express');
const announcementConfig = require('../config/announcement');
const featureFlags = require('../config/featureFlags');

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

// GET /api/site/features — public, read-only: the flagged features that are
// in beta or out for everyone, with the day they entered beta, the day they
// were released and the forum thread a super admin linked. The app combines
// this with the user's own "Try new features early" preference to decide
// which screens to show, and Settings → Early access lists it. A feature
// switched off is left out entirely: unfinished work stays invisible. The
// English titles and the notification bookkeeping stay server-side.
// Same cost and cache as the announcement: in-memory config, 60 s.
router.get('/features', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    features: featureFlags.list()
      .filter((f) => f.state !== 'off')
      .map(({ key, state, betaAt, releasedAt, forumPath }) => ({ key, state, betaAt, releasedAt, forumPath })),
  });
});

module.exports = router;
