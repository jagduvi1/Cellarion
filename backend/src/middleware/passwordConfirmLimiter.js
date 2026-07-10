const rateLimit = require('express-rate-limit');
const rateLimitsConfig = require('../config/rateLimits');
const { rateLimitKey } = require('../utils/clientIp');
const { logAudit } = require('../services/audit');

// Shared limiter for the "confirm your account password" surfaces that mint a
// durable credential: personal API-token creation (routes/tokens.js) and
// climate device creation (routes/climate.js). Both bcrypt-compare the account
// password, so they are the same password-guessing surface as login — and they
// must share ONE store, otherwise an attacker gets the auth budget once PER
// endpoint (login has its own limiter AND the account-lockout counter; these
// two piggyback on this shared instance).
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
