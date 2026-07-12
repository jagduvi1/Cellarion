const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Central place for issuing the access/refresh token pair and handling the
// refresh cookie. Shared by the password login flow (routes/auth.js) and the
// SSO flow (routes/oauth.js) so both mint IDENTICAL sessions — same JWT claims,
// same rotating + path-scoped refresh cookie, same absolute-lifetime cap.
// Extracted verbatim from routes/auth.js.

// Generate short-lived access token (default 15 min)
const generateAccessToken = (user) => {
  const roles = user.roles && user.roles.length > 0 ? user.roles : ['user'];
  return jwt.sign(
    { id: user._id, roles, plan: user.plan || 'free', planExpiresAt: user.planExpiresAt || null, isDemo: !!user.isDemo },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m' }
  );
};

// Generate opaque refresh token (random bytes) and store its hash on the user
const generateRefreshToken = () => crypto.randomBytes(64).toString('hex');

// Secure flag for the refresh cookie (L-22): dedicated COOKIE_SECURE override
// ('true'/'false'), falling back to the old NODE_ENV inference when unset.
// Self-hosters serving plain HTTP must set COOKIE_SECURE=false once the image
// ships with NODE_ENV=production, or the browser will drop the cookie.
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

// Cookie options for the httpOnly refresh token. path-scoped to /api/auth
// (L-23) so the 30-day credential only rides on auth endpoints instead of
// every backend request (uploads, JSON APIs, SSE) where it could land in
// logs/proxies. sameSite:'lax' is what lets the cookie survive the top-level
// OAuth redirect back from the identity provider.
const refreshCookieBase = {
  httpOnly: true,
  secure: COOKIE_SECURE,
  sameSite: 'lax',
  path: '/api/auth'
};

// Backward-compatible default (7-day persistent cookie)
const refreshCookieOptions = { ...refreshCookieBase, maxAge: 7 * 24 * 60 * 60 * 1000 };

// Clear the refresh cookie. clearCookie only removes a cookie whose path
// matches, so we clear BOTH the scoped path and the legacy path '/' — sessions
// issued before the /api/auth scoping (L-23) still carry a path=/ cookie until
// their next rotation, and clearing only the scoped variant would silently
// leave the old credential behind. The legacy clear can be dropped once all
// pre-scoping sessions have aged out (30-day absolute lifetime).
// Uses refreshCookieBase (no maxAge): passing maxAge to clearCookie makes
// Express re-derive a FUTURE expiry, leaving an empty cookie behind instead
// of deleting it.
const clearRefreshCookie = (res) => {
  res.clearCookie('refreshToken', refreshCookieBase);
  res.clearCookie('refreshToken', { ...refreshCookieBase, path: '/' });
};

// Build cookie options based on rememberMe preference
const buildCookieOptions = (rememberMe) => {
  if (rememberMe === false) {
    // Session cookie — no maxAge means it expires when the browser closes
    return { ...refreshCookieBase };
  }
  return refreshCookieOptions;
};

// Absolute refresh-token lifetime: a session may be rotated for at most this
// long before re-login is forced, regardless of refresh activity. Bounds how
// long a stolen-but-rotated refresh token stays usable.
const REFRESH_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Issue both tokens: access token in body, refresh token in httpOnly cookie.
// preserveLifetime=true (rotation via /refresh) keeps the existing absolute
// deadline; otherwise (login/register/re-auth/SSO) a fresh 30-day deadline is set.
const issueTokens = async (user, res, { rememberMe, preserveLifetime = false } = {}) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();
  user.setRefreshToken(refreshToken);
  if (!preserveLifetime) {
    user.refreshTokenExpiresAt = new Date(Date.now() + REFRESH_ABSOLUTE_LIFETIME_MS);
  }
  // Persist the remember-me choice at session start so rotation paths
  // (/refresh, /change-password) reissue the same cookie kind instead of
  // silently upgrading a session cookie to a persistent one.
  if (rememberMe !== undefined) {
    user.refreshTokenPersistent = rememberMe;
  } else {
    rememberMe = user.refreshTokenPersistent === false ? false : true;
  }
  await user.save();
  res.cookie('refreshToken', refreshToken, buildCookieOptions(rememberMe));
  return accessToken;
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  COOKIE_SECURE,
  refreshCookieBase,
  refreshCookieOptions,
  clearRefreshCookie,
  buildCookieOptions,
  REFRESH_ABSOLUTE_LIFETIME_MS,
  issueTokens,
};
