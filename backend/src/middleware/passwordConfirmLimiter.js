const rateLimit = require('express-rate-limit');
const rateLimitsConfig = require('../config/rateLimits');
const { rateLimitKey } = require('../utils/clientIp');
const { logAudit } = require('../services/audit');

// Shared limiter for the "confirm your account password" surfaces that mint a
// durable credential: API-token creation (routes/tokens.js), climate device
// creation (routes/climate.js) and bridge key creation (routes/bridgeKeys.js).
// Each bcrypt-compares the account password — the same password-guessing
// surface as login — so they share ONE store; otherwise an attacker gets the
// auth budget once PER endpoint (login has its own limiter AND the
// account-lockout counter; these piggyback on this shared instance).
//
// Exported as a single constructed instance on purpose: mounting the same
// middleware on multiple routes shares its MemoryStore, keyed by client IP.
const passwordConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => rateLimitsConfig.get().auth.max,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'auth', limit: rateLimitsConfig.get().auth.max });
    res.status(429).json({ error: 'Too many attempts, please try again later' });
  },
});

module.exports = { passwordConfirmLimiter };
