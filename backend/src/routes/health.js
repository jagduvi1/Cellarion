const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { version } = require('../../package.json');
const { isDraining } = require('../services/shutdown');

// GET /api/health - Health check endpoint
//
// 503 while the process is shutting down (services/shutdown): a deploy's
// health gate and the container healthcheck must read the process that is
// going as not ready, not as fine — until 2026-09-27 it answered 200 to the
// last (release audit, L).
router.get('/', (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  if (isDraining()) {
    return res.status(503).json({ status: 'draining', mongo: mongoStatus, version });
  }
  const statusCode = mongoStatus === 'connected' ? 200 : 503;

  res.status(statusCode).json({
    status: mongoStatus === 'connected' ? 'ok' : 'degraded',
    mongo: mongoStatus,
    version,
  });
});

module.exports = router;
