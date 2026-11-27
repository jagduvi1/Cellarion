const rateLimit = require('express-rate-limit');
const { logAudit } = require('../services/audit');

/**
 * Per-user limiter for POST /api/bottles/import/validate when the import asks
 * no AI (config/importPolicy, or no provider configured).
 *
 * With an AI the request is paced by the AI burst limiter
 * (middleware/aiBurstLimiter), sized for the cost of the calls. Without one
 * that pace is far too slow for a file of two thousand rows, but a validate
 * request is still not free: each row the registry does not know costs a
 * fuzzy search and a handful of reads. This bounds how many such requests one
 * member can run at once and per minute. Sixty a minute lets a 2,000-row file
 * (80 batches of 25) through in under two minutes.
 *
 * Keyed on req.user.id, like the AI limiter: a member rotating addresses is
 * still one member. The per-address limiters in app.js run alongside.
 * requireAuth must run before this.
 */
const VALIDATE_PER_MINUTE = 60;

const importValidateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: VALIDATE_PER_MINUTE,
  keyGenerator: (req) => String(req.user?.id || ''),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'import-validate', userId: req.user?.id });
    res.status(429).json({ error: 'Too many import requests in a short time. Please wait a minute and try again.' });
  },
});

module.exports = importValidateLimiter;
module.exports.VALIDATE_PER_MINUTE = VALIDATE_PER_MINUTE;
