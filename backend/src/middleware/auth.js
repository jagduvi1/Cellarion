const jwt = require('jsonwebtoken');
const { isApiTokenCredential, authenticateApiToken } = require('./apiTokenAuth');

// Middleware to verify JWT and attach user to request
const requireAuth = async (req, res, next) => {
  try {
    // Get token from Authorization header (format: "Bearer <token>")
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix

    // Personal API tokens (cel_...) take a separate, scope-checked path —
    // DB-backed and instantly revocable, unlike stateless JWTs. The prefix
    // can never collide with a JWT (JWTs start with a base64url JSON header).
    if (isApiTokenCredential(token)) {
      return authenticateApiToken(req, res, next, token);
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Support old tokens that carry a single `role` string
    const roles = decoded.roles || (decoded.role ? [decoded.role] : ['user']);

    // Resolve effective plan: downgrade to free if the plan has expired
    const planExpired = decoded.planExpiresAt && Date.now() > new Date(decoded.planExpiresAt).getTime();
    const effectivePlan = planExpired ? 'free' : (decoded.plan || 'free');

    // Attach user info to request
    req.user = {
      id: decoded.id,
      roles,
      plan: effectivePlan,
      planExpiresAt: decoded.planExpiresAt || null,
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    // Any other verification failure (JsonWebTokenError, NotBeforeError,
    // malformed/garbage token, etc.) is an authentication failure — never a 500.
    // No token is ever accepted on this path; a 500 here only masks auth
    // failures as server errors in monitoring.
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Same JWT decode as requireAuth, but missing/invalid tokens leave req.user = null
// instead of returning 401. Use this on routes that are public-readable but
// need to know "who am I, if anyone" — e.g. forum list/detail with personalized
// flags like `liked`, or future "you have this in your cellar" hints.
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const token = authHeader.substring(7);

    // API tokens are deliberately NOT honored on optionalAuth routes: those are
    // public-readable pages with personalization, none of which a machine token
    // needs — and keeping tokens off them keeps the scope allowlist the single
    // definition of what a token can reach.
    if (isApiTokenCredential(token)) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const roles = decoded.roles || (decoded.role ? [decoded.role] : ['user']);
    const planExpired = decoded.planExpiresAt && Date.now() > new Date(decoded.planExpiresAt).getTime();
    const effectivePlan = planExpired ? 'free' : (decoded.plan || 'free');

    req.user = {
      id: decoded.id,
      roles,
      plan: effectivePlan,
      planExpiresAt: decoded.planExpiresAt || null,
    };
  } catch {
    req.user = null;
  }
  next();
};

// Middleware to check user has a specific role
const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!req.user.roles.includes(role)) {
      return res.status(403).json({ error: `Access denied. ${role} role required.` });
    }
    next();
  };
};

/**
 * Middleware that allows both somm and admin roles.
 * Used to protect sommelier queue routes.
 */
const requireSommOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!req.user.roles.includes('somm') && !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Access denied. Sommelier or admin role required.' });
  }
  next();
};

/**
 * Middleware that allows moderator and admin roles.
 * Used to protect discussion moderation routes.
 */
const requireModeratorOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!req.user.roles.includes('moderator') && !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Access denied. Moderator or admin role required.' });
  }
  next();
};

/**
 * Convenience predicate used by handlers to branch on "is the requester a
 * forum moderator OR admin?". Centralised here so the four+ inline copies
 * across route handlers stop drifting (one of them used to forget admin).
 *
 * @param {{roles?: string[]}|null} user — typically req.user from optionalAuth
 * @returns {boolean}
 */
function isModerator(user) {
  if (!user || !Array.isArray(user.roles)) return false;
  return user.roles.includes('moderator') || user.roles.includes('admin');
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireRole,
  requireSommOrAdmin,
  requireModeratorOrAdmin,
  isModerator,
};
