const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { checkIsSuperAdmin } = require('../middleware/superAdmin');
const { logAudit } = require('../services/audit');
const { CURRENT_PRIVACY_POLICY_VERSION } = require('../config/legal');
const rateLimitsConfig = require('../config/rateLimits');
const { sendVerificationEmail, sendPasswordResetEmail, sendAccountLockoutAlert, EMAIL_VERIFICATION_ENABLED } = require('../services/mailgun');
const { isAccountLocked, recordLoginFailure, resetLoginAttempts } = require('../utils/loginAttempts');
const PendingShare = require('../models/PendingShare');
const Cellar = require('../models/Cellar');
const { createNotification } = require('../services/notifications');
const { rateLimitKey } = require('../utils/clientIp');

/**
 * Resolve any pending cellar shares for a newly registered / verified user.
 * Adds the user as a member to each cellar and creates notifications.
 */
async function resolvePendingShares(user) {
  try {
    const pending = await PendingShare.find({ email: user.email }).populate('invitedBy', 'username').populate('cellar', 'name');
    if (!pending.length) return;

    for (const invite of pending) {
      // Skip if cellar was deleted or user is already a member
      if (!invite.cellar) continue;
      const cellar = await Cellar.findById(invite.cellar._id);
      if (!cellar || cellar.deletedAt) continue;

      const alreadyMember = cellar.members.some(m => m.user.toString() === user._id.toString());
      if (alreadyMember) continue;

      cellar.members.push({ user: user._id, role: invite.role });
      await cellar.save();

      createNotification(
        user._id,
        'cellar_shared',
        'Cellar shared with you',
        `${invite.invitedBy?.username ?? 'Someone'} shared their cellar "${invite.cellar.name}" with you (${invite.role}).`,
        '/cellars'
      );
    }

    await PendingShare.deleteMany({ email: user.email });
  } catch (err) {
    console.error('Failed to resolve pending shares:', err.message);
  }
}

const router = express.Router();

// Dummy hash compared on login when the identifier matches no account, so the
// response time is indistinguishable from a real wrong-password compare and
// cannot be used for account enumeration (L-1). It MUST be generated at
// User.BCRYPT_COST (12) — a cheaper hash compares ~4x faster and reopens the
// timing oracle. Regenerate if the cost ever changes:
//   node -e "console.log(require('bcryptjs').hashSync(require('crypto').randomBytes(32).toString('hex'), 12))"
const DUMMY_HASH = '$2a$12$KHe5z0O8iNPzEuBLuI.qQOzUxRhCDEIAkNnrno5lWxvC4andqTkfm';
if (bcrypt.getRounds(DUMMY_HASH) !== User.BCRYPT_COST) {
  throw new Error(`DUMMY_HASH cost ${bcrypt.getRounds(DUMMY_HASH)} != BCRYPT_COST ${User.BCRYPT_COST} — regenerate DUMMY_HASH in routes/auth.js`);
}

// Rate limiter for auth endpoints — default 10 per 15 min (admin-configurable)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => rateLimitsConfig.get().auth.max,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'auth', limit: rateLimitsConfig.get().auth.max });
    res.status(429).json({ error: 'Too many attempts, please try again later' });
  }
});

// Separate limiter for forgot-password — 5 per 15 min to prevent abuse
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many attempts, please try again later' });
  }
});

// Separate limiter for resend — 5 per 15 min to prevent email-bombing
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many resend attempts, please try again later' });
  }
});

// Generate short-lived access token (default 15 min)
const generateAccessToken = (user) => {
  const roles = user.roles && user.roles.length > 0 ? user.roles : ['user'];
  return jwt.sign(
    { id: user._id, roles, plan: user.plan || 'free', planExpiresAt: user.planExpiresAt || null },
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
// logs/proxies.
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
// deadline; otherwise (login/register/re-auth) a fresh 30-day deadline is set.
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

// POST /api/auth/register - Register new user
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, consentPrivacyPolicy, consentDataProcessing } = req.body;

    // Validate input — require strings so a non-string email (number, object)
    // fails with a 400 instead of throwing on .toLowerCase() (same guard as login)
    if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string'
        || !username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    // Constrain the username: 3–30 chars, and only letters/numbers/._- . This
    // blocks an email-shaped username (login resolves username OR email, so a
    // username like "victim@example.com" could shadow that email's login) and
    // caps length. Enforced at registration only, so existing accounts that
    // predate the rule aren't broken on unrelated saves.
    const uname = typeof username === 'string' ? username.trim() : '';
    if (uname.length < 3 || uname.length > 30 || !/^[a-z0-9_.-]+$/i.test(uname)) {
      return res.status(400).json({ error: 'Username must be 3–30 characters and use only letters, numbers, dots, underscores, or hyphens.' });
    }

    if (!consentPrivacyPolicy || !consentDataProcessing) {
      return res.status(400).json({ error: 'You must accept the privacy policy and consent to data processing to register' });
    }

    // Check if user already exists (use generic message to prevent account enumeration)
    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }]
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Registration failed. Please check your details and try again.' });
    }

    // Create new user
    const user = new User({
      username,
      email,
      password,
      roles: ['user'],
      gdprConsent: {
        privacyPolicy: { accepted: true, acceptedAt: new Date(), version: CURRENT_PRIVACY_POLICY_VERSION },
        dataProcessing: { accepted: true, acceptedAt: new Date() }
      }
    });

    if (EMAIL_VERIFICATION_ENABLED) {
      // Generate verification token, save user, send email — no JWT issued yet
      const verificationToken = user.setEmailVerificationToken();
      await user.save();

      sendVerificationEmail(user.email, user.username, verificationToken).catch(err => {
        console.error('Failed to send verification email:', err.message);
      });

      logAudit(req, 'auth.register',
        { type: 'user', id: user._id },
        { username: user.username, email: user.email }
      );

      return res.status(202).json({
        message: 'Registration successful. Please check your email to verify your account.',
        email: user.email
      });
    }

    // Verification disabled — issue tokens immediately (current behaviour)
    user.emailVerified = true;
    const accessToken = await issueTokens(user, res);

    logAudit(req, 'auth.register',
      { type: 'user', id: user._id },
      { username: user.username, email: user.email }
    );

    // Resolve any pending cellar shares for this email
    resolvePendingShares(user).catch(() => {});

    res.status(201).json({
      token: accessToken,
      user: user.toJSON()
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login - Login user
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;

    // Validate input — require strings. Without the type check, an object like
    // {"$ne":null} passes the truthiness test, then `.toLowerCase()` throws a
    // 500 (and a NoSQL operator would otherwise reach the query). Coercing to
    // string both fixes the crash and neutralises operator injection.
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user by username or email
    const user = await User.findOne({
      $or: [{ username: username.toLowerCase() }, { email: username.toLowerCase() }]
    });

    // Always run bcrypt.compare to prevent timing-based user enumeration
    // (DUMMY_HASH is defined at module scope, pinned to User.BCRYPT_COST)
    const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);

    // Per-account brute-force protection. A locked account behaves IDENTICALLY
    // to a wrong-password response — same 401, same generic message, same
    // latency (bcrypt already ran above). This deprives a credential-stuffing
    // attacker of any feedback signal about whether they've tripped the lock.
    if (user && isAccountLocked(user)) {
      logAudit(req, 'auth.login.locked',
        { type: 'user', id: user._id },
        { username: user.username }
      );
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user) {
      logAudit(req, 'auth.login.failed', {}, { identifier: username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!isMatch) {
      // Record failure, check if it crossed the lockout threshold, fire alert
      // email (deduped) if this is a new lockout event. Non-blocking: any
      // failure in the email path is logged but doesn't affect the response.
      const { lockedNow, shouldSendEmail } = recordLoginFailure(user);
      try { await user.save(); } catch (err) { console.warn('Failed to persist login-failure counter:', err.message); }
      if (lockedNow) {
        logAudit(req, 'auth.account_locked',
          { type: 'user', id: user._id },
          { username: user.username, threshold: rateLimitsConfig.get().accountLockout.threshold }
        );
      }
      if (shouldSendEmail) {
        sendAccountLockoutAlert(user.email, user.username).catch(err =>
          console.warn('Failed to send account-lockout alert:', err.message)
        );
      }
      logAudit(req, 'auth.login.failed',
        { type: 'user', id: user._id },
        { username: user.username }
      );
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Block login until email is verified (only when verification is enabled)
    if (EMAIL_VERIFICATION_ENABLED && !user.emailVerified) {
      logAudit(req, 'auth.login.unverified',
        { type: 'user', id: user._id },
        { username: user.username }
      );
      return res.status(403).json({
        error: 'Please verify your email address before logging in.',
        code: 'EMAIL_NOT_VERIFIED',
        email: user.email
      });
    }

    // Successful login: clear any failed-attempt counter the user had built up.
    // Save errors here are non-fatal — the login itself succeeded.
    if (resetLoginAttempts(user)) {
      try { await user.save(); } catch (err) { console.warn('Failed to reset login-attempt counter:', err.message); }
    }

    const accessToken = await issueTokens(user, res, { rememberMe: rememberMe !== false });

    logAudit(req, 'auth.login.success',
      { type: 'user', id: user._id },
      { username: user.username }
    );

    const loginUserJson = user.toJSON();
    loginUserJson.isSuperAdmin = checkIsSuperAdmin(req, user.email);

    res.json({
      token: accessToken,
      user: loginUserJson
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/verify-email?token=:token - Verify email address
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Verification token is required' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({ emailVerificationTokenHash: tokenHash });

    if (!user || !user.validateEmailVerificationToken(token)) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    user.emailVerified = true;
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpiresAt = null;

    const accessToken = await issueTokens(user, res);

    logAudit(req, 'auth.email_verified',
      { type: 'user', id: user._id },
      { username: user.username, email: user.email }
    );

    // Resolve any pending cellar shares for this email
    resolvePendingShares(user).catch(() => {});

    res.json({
      message: 'Email verified successfully.',
      token: accessToken,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Email verification failed' });
  }
});

// POST /api/auth/resend-verification - Resend verification email
router.post('/resend-verification', resendLimiter, async (req, res) => {
  const { email } = req.body;

  // String check for the same reason as login/register: .toLowerCase() on a
  // non-string body value must be a 400, not a 500.
  if (typeof email !== 'string' || !email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  // Always respond with the same message to prevent email enumeration
  const genericResponse = { message: 'If that email exists and is unverified, a new link has been sent.' };

  try {
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user || user.emailVerified || !EMAIL_VERIFICATION_ENABLED) {
      return res.status(200).json(genericResponse);
    }

    const verificationToken = user.setEmailVerificationToken();
    await user.save();

    sendVerificationEmail(user.email, user.username, verificationToken).catch(err => {
      console.error('Failed to resend verification email:', err.message);
    });

    logAudit(req, 'auth.verification_resent',
      { type: 'user', id: user._id },
      { email: user.email }
    );

    res.status(200).json(genericResponse);
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// Rate limiter for refresh — 30 per 15 min to prevent abuse
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many refresh attempts, please try again later' });
  }
});

// POST /api/auth/refresh - Issue new access token using httpOnly refresh token cookie
router.post('/refresh', refreshLimiter, async (req, res) => {
  const incomingToken = req.cookies?.refreshToken;
  if (!incomingToken) {
    return res.status(401).json({ error: 'No refresh token' });
  }

  try {
    // Decode without verification to get the user ID, then validate hash in DB
    // (Refresh tokens are opaque random bytes — not JWTs — so just look up by hash)
    // We find the user whose stored hash matches this token
    const tokenHash = crypto.createHash('sha256').update(incomingToken).digest('hex');
    const user = await User.findOne({ refreshTokenHash: tokenHash });

    if (!user) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Enforce the absolute session deadline. Rotation must NOT extend it, so an
    // attacker who keeps rotating a stolen token is still cut off after the cap.
    if (user.refreshTokenExpiresAt && Date.now() > user.refreshTokenExpiresAt.getTime()) {
      user.refreshTokenHash = null;
      user.refreshTokenExpiresAt = null;
      await user.save();
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }

    // Rotate: issue new pair (invalidates the old refresh token hash). Preserve
    // the existing deadline when set; backfill legacy sessions (null) so every
    // session eventually gets an absolute cap.
    const accessToken = await issueTokens(user, res, { preserveLifetime: !!user.refreshTokenExpiresAt });

    res.json({ token: accessToken });
  } catch (error) {
    console.error('Refresh error:', error);
    clearRefreshCookie(res);
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /api/auth/change-password - Change password while authenticated
router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      logAudit(req, 'auth.change_password.failed',
        { type: 'user', id: user._id },
        { reason: 'incorrect_current_password' }
      );
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    user.password = newPassword;
    user.refreshTokenHash = null; // Invalidate all existing sessions

    const accessToken = await issueTokens(user, res);

    logAudit(req, 'auth.change_password',
      { type: 'user', id: user._id },
      { username: user.username }
    );

    res.json({
      message: 'Password changed successfully.',
      token: accessToken
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// POST /api/auth/logout - Invalidate refresh token
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user) {
      user.refreshTokenHash = null;
      await user.save();
    }
    clearRefreshCookie(res);
    res.json({ message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /api/auth/me - Get current user (protected)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userJson = user.toJSON();
    // Stamp isSuperAdmin: true only when email + IP conditions are both satisfied.
    // This controls whether the super admin nav link appears in the frontend.
    userJson.isSuperAdmin = checkIsSuperAdmin(req, user.email);

    res.json({ user: userJson });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /api/auth/forgot-password - Request a password reset link
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const { email } = req.body;
  // Always return the same message to prevent email enumeration
  const genericResponse = { message: 'If that email exists, a password reset link has been sent.' };

  if (typeof email !== 'string' || !email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(200).json(genericResponse);
    }

    const resetToken = user.setPasswordResetToken();
    await user.save();

    if (EMAIL_VERIFICATION_ENABLED) {
      sendPasswordResetEmail(user.email, user.username, resetToken).catch(err => {
        console.error('Failed to send password reset email:', err.message);
      });
    }

    logAudit(req, 'auth.password_reset_requested',
      { type: 'user', id: user._id },
      { email: user.email }
    );

    res.status(200).json(genericResponse);
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/auth/reset-password - Set a new password using a reset token
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({ passwordResetTokenHash: tokenHash });

    if (!user || !user.validatePasswordResetToken(token)) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    user.password = password;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    user.refreshTokenHash = null; // Invalidate all existing sessions
    // Successful password reset is the user's explicit recovery signal —
    // clear any brute-force lockout state too. Otherwise a locked user
    // would still be locked after resetting their password.
    resetLoginAttempts(user);

    await user.save();

    logAudit(req, 'auth.password_reset',
      { type: 'user', id: user._id },
      { username: user.username }
    );

    clearRefreshCookie(res);
    res.status(200).json({ message: 'Password reset successfully. You can now log in with your new password.' });
  } catch (error) {
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
