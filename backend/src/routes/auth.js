const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { checkIsSuperAdmin } = require('../middleware/superAdmin');
const { logAudit } = require('../services/audit');
const rateLimitsConfig = require('../config/rateLimits');
const { sendVerificationEmail, sendPasswordResetEmail, EMAIL_VERIFICATION_ENABLED } = require('../services/mailgun');
const PendingShare = require('../models/PendingShare');
const Cellar = require('../models/Cellar');
const { createNotification } = require('../services/notifications');
const { getClientIp } = require('../utils/clientIp');

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

// Rate limiter for auth endpoints — default 10 per 15 min (admin-configurable)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => rateLimitsConfig.get().auth.max,
  keyGenerator: (req) => getClientIp(req),
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
  keyGenerator: (req) => getClientIp(req),
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
  keyGenerator: (req) => getClientIp(req),
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

// Cookie options for the httpOnly refresh token
const refreshCookieBase = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict'
};

// Backward-compatible default (7-day persistent cookie)
const refreshCookieOptions = { ...refreshCookieBase, maxAge: 7 * 24 * 60 * 60 * 1000 };

// Build cookie options based on rememberMe preference
const buildCookieOptions = (rememberMe) => {
  if (rememberMe === false) {
    // Session cookie — no maxAge means it expires when the browser closes
    return { ...refreshCookieBase };
  }
  return refreshCookieOptions;
};

// Issue both tokens: access token in body, refresh token in httpOnly cookie
const issueTokens = async (user, res, { rememberMe } = {}) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();
  user.setRefreshToken(refreshToken);
  await user.save();
  res.cookie('refreshToken', refreshToken, buildCookieOptions(rememberMe));
  return accessToken;
};

// POST /api/auth/register - Register new user
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, consentPrivacyPolicy, consentDataProcessing } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
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
        privacyPolicy: { accepted: true, acceptedAt: new Date(), version: '2026-03' },
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

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user by username or email
    const user = await User.findOne({
      $or: [{ username: username.toLowerCase() }, { email: username.toLowerCase() }]
    });

    // Always run bcrypt.compare to prevent timing-based user enumeration
    const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);

    if (!user) {
      logAudit(req, 'auth.login.failed', {}, { identifier: username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!isMatch) {
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

  if (!email) {
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
  keyGenerator: (req) => getClientIp(req),
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
      res.clearCookie('refreshToken', refreshCookieOptions);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Rotate: issue new pair (invalidates the old refresh token hash)
    const accessToken = await issueTokens(user, res);

    res.json({ token: accessToken });
  } catch (error) {
    console.error('Refresh error:', error);
    res.clearCookie('refreshToken', refreshCookieOptions);
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
    res.clearCookie('refreshToken', refreshCookieOptions);
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

  if (!email) {
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

    await user.save();

    logAudit(req, 'auth.password_reset',
      { type: 'user', id: user._id },
      { username: user.username }
    );

    res.clearCookie('refreshToken', refreshCookieOptions);
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
