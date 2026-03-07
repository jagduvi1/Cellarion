const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// GET /api/health/ip - Temporary IP diagnostics (remove after debugging)
router.get('/ip', (req, res) => {
  res.json({
    'req.ip':               req.ip,
    'req.ips':              req.ips,
    'x-forwarded-for':      req.headers['x-forwarded-for'] || null,
    'x-real-ip':            req.headers['x-real-ip'] || null,
    'connection.remoteAddress': req.socket?.remoteAddress || null,
    'trust proxy setting':  req.app.get('trust proxy'),
  });
});

// GET /api/health - Health check endpoint
router.get('/', (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const statusCode = mongoStatus === 'connected' ? 200 : 503;

  res.status(statusCode).json({
    status: mongoStatus === 'connected' ? 'ok' : 'degraded',
    mongo: mongoStatus,
    uptime: process.uptime()
  });
});

module.exports = router;
