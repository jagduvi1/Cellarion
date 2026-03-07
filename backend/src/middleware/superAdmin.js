const User = require('../models/User');
const { logAudit } = require('../services/audit');

/**
 * Middleware that restricts access to the configured Super Admin.
 * Must be used AFTER requireAuth.
 *
 * Security checks (all must pass):
 *  1. SUPER_ADMIN_EMAIL env var is set
 *  2. Request IP is in SUPER_ADMIN_IPS allowlist (if configured; empty = allow any)
 *  3. Authenticated user's email (from DB) matches SUPER_ADMIN_EMAIL
 *
 * All access attempts are written to the audit log.
 */
const requireSuperAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
  if (!superAdminEmail) {
    // Feature not configured — treat as disabled
    return res.status(403).json({ error: 'Access denied' });
  }

  // IP allowlist check
  const rawIPs = process.env.SUPER_ADMIN_IPS || '';
  const allowedIPs = rawIPs.split(',').map(ip => ip.trim()).filter(Boolean);
  if (allowedIPs.length > 0) {
    const clientIP = req.ip;
    if (!allowedIPs.includes(clientIP)) {
      // Generic error — do not reveal allowlist content
      logAudit(req, 'superadmin.access.blocked', {}, { reason: 'ip_not_allowed', ip: clientIP });
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  // DB lookup to verify email (JWT does not carry the email field)
  let dbUser;
  try {
    dbUser = await User.findById(req.user.id).select('email').lean();
  } catch {
    return res.status(500).json({ error: 'Authentication error' });
  }

  if (!dbUser || dbUser.email !== superAdminEmail) {
    logAudit(req, 'superadmin.access.blocked', {}, { reason: 'email_mismatch' });
    return res.status(403).json({ error: 'Access denied' });
  }

  logAudit(req, 'superadmin.access', {}, { path: req.path, method: req.method });
  next();
};

/**
 * Non-throwing helper used by /api/auth/me to stamp the user object with
 * { isSuperAdmin: true } when all super-admin conditions are met from the
 * request context. Keeps the /me handler clean.
 *
 * @param {import('express').Request} req
 * @param {string} userEmail - The email already fetched from DB by the /me handler
 * @returns {boolean}
 */
const checkIsSuperAdmin = (req, userEmail) => {
  const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
  if (!superAdminEmail) return false;
  if (userEmail !== superAdminEmail) return false;

  const rawIPs = process.env.SUPER_ADMIN_IPS || '';
  const allowedIPs = rawIPs.split(',').map(ip => ip.trim()).filter(Boolean);
  if (allowedIPs.length > 0 && !allowedIPs.includes(req.ip)) return false;

  return true;
};

module.exports = { requireSuperAdmin, checkIsSuperAdmin };
