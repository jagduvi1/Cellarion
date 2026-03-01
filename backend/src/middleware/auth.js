const jwt = require('jsonwebtoken');
const { planHasFeature, getRequiredPlanForFeature } = require('../config/plans');

// Middleware to verify JWT and attach user to request
const requireAuth = async (req, res, next) => {
  try {
    // Get token from Authorization header (format: "Bearer <token>")
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(500).json({ error: 'Authentication error' });
  }
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
 * Middleware factory that checks whether the requesting user's plan
 * includes the named feature. Returns 403 with the required plan if not.
 * Must be used after requireAuth.
 */
const requireFeature = (featureName) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!planHasFeature(req.user.plan, featureName)) {
      const requiredPlan = getRequiredPlanForFeature(featureName);
      return res.status(403).json({
        error: `This feature requires the ${requiredPlan} plan.`,
        feature: featureName,
        requiredPlan,
        currentPlan: req.user.plan,
      });
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

module.exports = {
  requireAuth,
  requireRole,
  requireFeature,
  requireSommOrAdmin,
};
