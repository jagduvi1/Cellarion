const rateLimit = require('express-rate-limit');
const rateLimitsConfig = require('../config/rateLimits');
const { logAudit } = require('../services/audit');

/**
 * Per-user burst limiter for all Anthropic-backed endpoints — the wine AI
 * routes (/wines/scan-label, /identify-text, /ai-info) and bottle import
 * (/bottles/import/validate, which fans out one identify call per wine).
 *
 * Keyed on req.user.id (not IP) so a scripted attacker rotating IPs can't
 * bypass it. The per-IP apiLimiter still runs alongside. All consumers share
 * ONE bucket because they share one Anthropic budget. `max` is read live from
 * the admin-tunable rate-limit config; requireAuth must run before this so
 * req.user is populated.
 */
const aiBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => rateLimitsConfig.get().aiBurst.max,
  keyGenerator: (req) => String(req.user?.id || ''),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'ai-burst', userId: req.user?.id });
    res.status(429).json({ error: 'Too many AI requests in a short time. Please wait a minute and try again.' });
  },
});

module.exports = aiBurstLimiter;
