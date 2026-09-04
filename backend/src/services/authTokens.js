const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

// Central place for issuing the access/refresh token pair and handling the
// refresh cookie. Shared by the password login flow (routes/auth.js) and the
// SSO flow (routes/oauth.js) so both mint IDENTICAL sessions — same JWT claims,
// same rotating + path-scoped refresh cookie, same absolute-lifetime cap.
//
// Sessions are PER DEVICE (2026-09-04). The account used to hold ONE refresh
// token hash, so signing in on the phone silently signed the laptop out: its
// cookie no longer matched anything, the next /refresh got a 401, and the
// client treated that as "session dead". On the hosted instance 247 of 313
// consecutive logins over two weeks were exactly that — the same person moving
// between devices. Now `user.sessions[]` carries one entry per signed-in
// browser; /refresh rotates only its own entry and /logout removes only its
// own entry. Password change/reset and account deletion still revoke ALL.

// Generate short-lived access token (default 15 min)
const generateAccessToken = (user) => {
  const roles = user.roles && user.roles.length > 0 ? user.roles : ['user'];
  return jwt.sign(
    { id: user._id, roles, plan: user.plan || 'free', planExpiresAt: user.planExpiresAt || null, isDemo: !!user.isDemo },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m' }
  );
};

// Generate opaque refresh token (random bytes); only its sha256 is stored
const generateRefreshToken = () => crypto.randomBytes(64).toString('hex');
const hashRefreshToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

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

// Devices per account. Bounds the user document; the least recently used
// entry is evicted when a new device signs in past the cap.
const MAX_SESSIONS_PER_USER = 10;

// A token that was rotated away and comes back within this window is a lost
// race — two tabs of one browser refreshing at once where the Web Locks
// single-flight is not available — not theft. Outside the window it is theft
// evidence (someone holds a copy of a cookie the real browser no longer has)
// and every session on the account is revoked.
const REUSE_GRACE_MS = 60 * 1000;

// Short device label for the sessions list. Data minimisation: an OS and a
// browser family are enough to tell the phone from the laptop; the raw
// user-agent string is never stored.
const clientHint = (req) => {
  const ua = String(req?.headers?.['user-agent'] || '');
  const os = /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows'
        : /Macintosh/.test(ua) ? 'Mac'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Linux/.test(ua) ? 'Linux'
              : null;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari'
            : null;
  const parts = [os, browser].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'Unknown device';
};

const sessionsOf = (user) => {
  if (!Array.isArray(user.sessions)) user.sessions = [];
  return user.sessions;
};
const expiryOf = (s) => (s.expiresAt ? new Date(s.expiresAt).getTime() : null);

// Drop entries past their absolute deadline. Returns how many went.
const pruneSessions = (user, now = Date.now()) => {
  const before = sessionsOf(user).length;
  user.sessions = user.sessions.filter((s) => expiryOf(s) === null || expiryOf(s) > now);
  return before - user.sessions.length;
};

// Remove one device's entry (by its current hash).
const removeSession = (user, session) => {
  user.sessions = sessionsOf(user).filter((s) => s.hash !== session.hash);
};

// Sign out everywhere: password change/reset, account-deletion request,
// refresh-token reuse. Also clears the legacy single-session fields.
const revokeAllSessions = (user) => {
  user.sessions = [];
  user.refreshTokenHash = null;
  user.refreshTokenExpiresAt = null;
  user.refreshTokenPersistent = null;
};

// The session entry a request's refresh cookie belongs to, or null.
const sessionForCookie = (user, req) => {
  const raw = req?.cookies?.refreshToken;
  if (!raw) return null;
  const hash = hashRefreshToken(raw);
  return sessionsOf(user).find((s) => s.hash === hash) || null;
};

/**
 * Resolve a presented refresh token to its owner and device session.
 * Returns null when it matches nothing, otherwise { user, session } plus:
 *  - reused: true / race: bool — the token was rotated away; `race` says it
 *    happened inside REUSE_GRACE_MS (benign) or not (theft signal)
 *  - migrated: true — a pre-sessions single-token row was adopted in place
 *    (the caller's rotation persists it), so the rollout signs nobody out
 */
const resolveRefreshSession = async (token) => {
  const hash = hashRefreshToken(token);

  let user = await User.findOne({ 'sessions.hash': hash });
  if (user) {
    return { user, session: sessionsOf(user).find((s) => s.hash === hash) };
  }

  user = await User.findOne({ 'sessions.prevHash': hash });
  if (user) {
    const session = sessionsOf(user).find((s) => s.prevHash === hash);
    const rotatedAt = session.rotatedAt ? new Date(session.rotatedAt).getTime() : 0;
    return { user, session, reused: true, race: Date.now() - rotatedAt < REUSE_GRACE_MS };
  }

  user = await User.findOne({ refreshTokenHash: hash });
  if (user) {
    const now = new Date(Date.now());
    sessionsOf(user).push({
      hash,
      prevHash: null,
      rotatedAt: null,
      expiresAt: user.refreshTokenExpiresAt || null,
      persistent: user.refreshTokenPersistent !== false,
      createdAt: now,
      lastUsedAt: now,
      client: 'Unknown device',
    });
    user.refreshTokenHash = null;
    user.refreshTokenExpiresAt = null;
    user.refreshTokenPersistent = null;
    return { user, session: user.sessions[user.sessions.length - 1], migrated: true };
  }

  return null;
};

/**
 * Issue both tokens: access token in body, refresh token in httpOnly cookie.
 *  - without `session`: START a device session (login / register / SSO /
 *    re-auth) with a fresh 30-day deadline (or `expiresAt`, e.g. the demo TTL)
 *  - with `session`: ROTATE that entry in place (/refresh) — deadline and
 *    remember-me choice preserved, every other device untouched
 */
const issueTokens = async (user, res, { rememberMe, session, client, expiresAt } = {}) => {
  const now = Date.now();
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();
  const hash = hashRefreshToken(refreshToken);
  let persistent;

  if (session) {
    session.prevHash = session.hash;
    session.rotatedAt = new Date(now);
    session.hash = hash;
    session.lastUsedAt = new Date(now);
    // Backfill legacy sessions (null) so every session eventually gets a cap;
    // never EXTEND an existing one — an attacker who keeps rotating a stolen
    // token is still cut off at the original deadline.
    if (!session.expiresAt) session.expiresAt = new Date(now + REFRESH_ABSOLUTE_LIFETIME_MS);
    persistent = session.persistent !== false;
  } else {
    pruneSessions(user, now);
    const list = sessionsOf(user);
    while (list.length >= MAX_SESSIONS_PER_USER) {
      let oldest = 0;
      for (let i = 1; i < list.length; i++) {
        if (new Date(list[i].lastUsedAt).getTime() < new Date(list[oldest].lastUsedAt).getTime()) oldest = i;
      }
      list.splice(oldest, 1);
    }
    persistent = rememberMe !== false;
    list.push({
      hash,
      prevHash: null,
      rotatedAt: null,
      expiresAt: expiresAt || new Date(now + REFRESH_ABSOLUTE_LIFETIME_MS),
      persistent,
      createdAt: new Date(now),
      lastUsedAt: new Date(now),
      client: client || 'Unknown device',
    });
  }

  await user.save();
  res.cookie('refreshToken', refreshToken, buildCookieOptions(persistent));
  return accessToken;
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  COOKIE_SECURE,
  refreshCookieBase,
  refreshCookieOptions,
  clearRefreshCookie,
  buildCookieOptions,
  REFRESH_ABSOLUTE_LIFETIME_MS,
  MAX_SESSIONS_PER_USER,
  REUSE_GRACE_MS,
  clientHint,
  pruneSessions,
  removeSession,
  revokeAllSessions,
  sessionForCookie,
  resolveRefreshSession,
  issueTokens,
};
