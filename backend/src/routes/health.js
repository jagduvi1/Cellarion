const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// GET /api/health - Health check endpoint
router.get('/', (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const statusCode = mongoStatus === 'connected' ? 200 : 503;

  res.status(statusCode).json({
    status: mongoStatus === 'connected' ? 'ok' : 'degraded',
    mongo: mongoStatus,
  });
});

module.exports = router;
