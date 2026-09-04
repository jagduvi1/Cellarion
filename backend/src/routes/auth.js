const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { checkIsSuperAdmin } = require('../middleware/superAdmin');
const { logAudit } = require('../services/audit');
const eventBus = require('../services/eventBus');
const { revokeOAuthConnectionsForUser } = require('../services/mcpOAuth');
const { CURRENT_PRIVACY_POLICY_VERSION } = require('../config/legal');
const rateLimitsConfig = require('../config/rateLimits');
const { sendVerificationEmail, sendPasswordResetEmail, sendAccountLockoutAlert, EMAIL_VERIFICATION_ENABLED } = require('../services/mailgun');
const { isAccountLocked, recordLoginFailure, resetLoginAttempts } = require('../utils/loginAttempts');
const { rateLimitKey } = require('../utils/clientIp');
// Token issuance + refresh-cookie handling and pending-share resolution are
// extracted to services so the password flow (here) and the SSO flow
// (routes/oauth.js) share one implementation.
const {
  issueTokens, clearRefreshCookie, clientHint, resolveRefreshSession,
  removeSession, revokeAllSessions, sessionForCookie, hashRefreshToken,
} = require('../services/authTokens');
const { resolvePendingShares } = require('../services/pendingShares');
const { createDemoAccountWithinCeiling } = require('../services/demoAccount');

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

// Enumeration-timing parity for /forgot-password + /resend-verification
// (security audit L-8). The "account found" branch pays a token-generation +
// user.save() write that the early-return branch skips, making a real account
// measurably slower — a timing oracle the equalized login flow already closed.
// A no-op write against a fresh random _id matches nothing (writes no data) but
// pays the same index-lookup + Mongo round-trip. Best-effort: never fail the
// request over it.
async function equalizeLookupTiming() {
  try {
    await User.updateOne(
      { _id: crypto.randomBytes(12).toString('hex') },
      { $set: { updatedAt: new Date() } }
    );
  } catch { /* timing parity only — swallow */ }
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

// Ephemeral public-demo creation limiter — default 3/hour per IP (admin-tunable
// max). Cloning a snapshot cellar per visitor is write-heavy, so this per-IP cap
// is tighter than authLimiter. windowMs is fixed at limiter-build time (like
// authLimiter); the durable global ceiling in the handler is the real backstop,
// since this in-memory limiter resets on every backend restart.
const demoLimiter = rateLimit({
  windowMs: rateLimitsConfig.defaults.demo.createWindowMs,
  max: () => rateLimitsConfig.get().demo.createMax,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'demo', limit: rateLimitsConfig.get().demo.createMax });
    res.status(429).json({ error: 'Too many demo sessions from this network. Please try again later, or create a free account.' });
  }
});

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
    const accessToken = await issueTokens(user, res, { client: clientHint(req) });

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

// POST /api/auth/demo-login - Create an ephemeral, auto-expiring demo account
// (no signup) and clone a populated sample cellar into it so an anonymous
// visitor can try Cellarion. The account is heavily guarded elsewhere: no AI
// spend, no password/account changes, no API-token minting (requireNonDemo +
// isDemo short-circuits), and it is fully erased by the demoSweepJob reaper once
// demoExpiresAt passes. Volume is bounded by demoLimiter (per-IP) plus a durable
// global ceiling (demo.globalMax; set to 0 to disable demos entirely).
router.post('/demo-login', demoLimiter, async (req, res) => {
  try {
    // Durable global ceiling — the real backstop against DB-bloat abuse, since
    // the in-memory per-IP limiter resets on restart. The count-check and the
    // insert are serialized into one atomic critical section (demoAccount) so a
    // concurrent burst can't overshoot the ceiling. null = at/over capacity
    // (demo.globalMax; 0 → always → demo kill-switch).
    const user = await createDemoAccountWithinCeiling();
    if (!user) {
      return res.status(429).json({ error: 'The live demo is at capacity right now. Please try again shortly, or create a free account.' });
    }

    // Bound the session to the demo TTL: the device session's deadline is the
    // account's expiry (no 30-day default), with a session cookie
    // (rememberMe:false). A page reload refreshes within the window; once the
    // account is reaped, /refresh 401s cleanly.
    const accessToken = await issueTokens(user, res, { expiresAt: user.demoExpiresAt, rememberMe: false, client: clientHint(req) });

    logAudit(req, 'auth.demo_login', { type: 'user', id: user._id }, { expiresAt: user.demoExpiresAt });

    res.status(201).json({ token: accessToken, user: user.toJSON() });
  } catch (error) {
    console.error('Demo login error:', error);
    res.status(500).json({ error: 'Could not start a demo session. Please try again.' });
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
    // (DUMMY_HASH is defined at module scope, pinned to User.BCRYPT_COST).
    // Fall back to the dummy hash both when there's no user AND when the user is
    // SSO-only (no local password) — comparing against `undefined` would throw,
    // and an SSO-only account must never authenticate via the password form.
    const isMatch = await bcrypt.compare(password, user && user.password ? user.password : DUMMY_HASH);

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

    const accessToken = await issueTokens(user, res, { rememberMe: rememberMe !== false, client: clientHint(req) });

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
// POST (not GET) and issues NO session (security audit M-1). The email link
// points at the SPA page /verify-email?token=…, which now POSTs the token here
// from same-origin JS. This closes two holes in the old session-issuing GET:
//   - login-CSRF / session-fixation: a cross-site GET to the old endpoint (or
//     to the SPA page) let an attacker's verification token Set-Cookie the
//     attacker's refresh cookie into a victim's browser (SameSite=Lax does not
//     block storing it), silently logging the victim into the attacker's
//     account. A POST is not triggerable by a plain cross-site navigation, and
//     issuing no session removes the fixation entirely — the user logs in
//     normally afterward.
//   - one-time-token burn by mail-security prefetchers: link scanners issue
//     GETs, not the SPA's POST, so they no longer consume the token.
router.post('/verify-email', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { token } = req.body || {};

  // typeof, not truthiness (security audit 2026-07-25 L-2): a JSON body value
  // like {"token":{"$ne":null}} is truthy, and crypto's update() then throws a
  // TypeError that the catch below turns into a 500 with a full stack trace.
  // Nothing is exploitable — it throws BEFORE the Mongo query, so no operator
  // ever reaches the database — but an unauthenticated endpoint should answer
  // 400 for a malformed token instead of logging noise on request.
  if (typeof token !== 'string' || !token) {
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
    await user.save();

    logAudit(req, 'auth.email_verified',
      { type: 'user', id: user._id },
      { username: user.username, email: user.email }
    );

    // Resolve any pending cellar shares for this email
    resolvePendingShares(user).catch(() => {});

    // No session is issued here — the client sends the user to log in.
    res.json({ verified: true, message: 'Email verified successfully. Please log in.' });
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
      await equalizeLookupTiming(); // L-8: match the found-branch write cost
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
    // Refresh tokens are opaque random bytes — not JWTs — so the cookie is
    // resolved by hash to the user AND the device session it belongs to
    // (services/authTokens.resolveRefreshSession). Other devices' sessions on
    // the same account are never touched here.
    const found = await resolveRefreshSession(incomingToken);

    if (!found) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    const { user, session, reused, race, migrated } = found;

    // A token that was already rotated away. Inside the grace window it is a
    // lost race between two tabs (the winner holds the live cookie) — a plain
    // 401, nothing revoked. Outside it, someone else holds a copy of a cookie
    // the real browser no longer has: sign the account out everywhere.
    if (reused) {
      if (!race) {
        revokeAllSessions(user);
        eventBus.dropUser(user._id);
        await user.save();
        logAudit(req, 'auth.session.reuse_detected', { type: 'user', id: user._id }, { client: session.client });
      }
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Enforce the absolute session deadline. Rotation must NOT extend it, so an
    // attacker who keeps rotating a stolen token is still cut off after the cap.
    if (session.expiresAt && Date.now() > new Date(session.expiresAt).getTime()) {
      removeSession(user, session);
      // The hard cap is a credential event — close open SSE streams too, but
      // only once no device session is left (they are per-account streams).
      if (user.sessions.length === 0) eventBus.dropUser(user._id);
      await user.save();
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }

    // A pre-sessions cookie adopted just now: label it with this device.
    if (migrated) session.client = clientHint(req);

    // Rotate THIS device's entry: new hash, old one kept as prevHash for reuse
    // detection, deadline preserved (legacy null backfilled to a fresh cap).
    const accessToken = await issueTokens(user, res, { session });

    res.json({ token: accessToken });
  } catch (error) {
    console.error('Refresh error:', error);
    clearRefreshCookie(res);
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /api/auth/change-password - Change password while authenticated
router.post('/change-password', requireAuth, requireNonDemo, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // SSO-only account: there is no current password to verify. The UI hides
    // this form for hasPassword:false and offers the set-password (reset-email)
    // flow instead — this guard catches direct API calls with an honest answer.
    if (!user.password) {
      return res.status(403).json({
        error: 'This account signs in with Google and has no password yet. Use "Set a password" to create one.',
        code: 'no_password',
      });
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
    // Invalidate every device session, then start a fresh one for THIS device
    // (keeping its remember-me choice) so the user changing the password
    // stays signed in here and nowhere else.
    const current = sessionForCookie(user, req);
    revokeAllSessions(user);
    // Also force-close any open SSE event streams — same trust boundary as
    // refresh sessions (docs/ha-push-events.md §1).
    eventBus.dropUser(user._id);

    const accessToken = await issueTokens(user, res, { // persists the new password
      rememberMe: current ? current.persistent !== false : true,
      client: clientHint(req),
    });
    // Revoke connected AI assistants (OAuth consent grants) — a third-party
    // grant must not outlive the "secure my account" action (security report
    // 2026-08-27). Personal API tokens (HA, climate) keep PAT semantics.
    const revokedConnections = await revokeOAuthConnectionsForUser(user._id);

    logAudit(req, 'auth.change_password',
      { type: 'user', id: user._id },
      { username: user.username, oauthConnectionsRevoked: revokedConnections }
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
      // Sign out THIS device only: drop the session its refresh cookie belongs
      // to (by current or just-rotated hash). Other devices keep their sessions.
      // A pre-sessions cookie still on the legacy field is cleared the same way.
      const raw = req.cookies?.refreshToken;
      const hash = raw ? hashRefreshToken(raw) : null;
      if (hash) {
        user.sessions = (user.sessions || []).filter((s) => s.hash !== hash && s.prevHash !== hash);
        if (user.refreshTokenHash === hash) {
          user.refreshTokenHash = null;
          user.refreshTokenExpiresAt = null;
          user.refreshTokenPersistent = null;
        }
      }
      await user.save();
      // Open SSE event streams are per account, so close them only when no
      // device session is left. An integration holding valid credentials
      // simply reconnects.
      if ((user.sessions || []).length === 0 && !user.refreshTokenHash) eventBus.dropUser(req.user.id);
    }
    clearRefreshCookie(res);
    res.json({ message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /api/auth/whoami — minimal stable identity for scoped integrations
// (e.g. the Home Assistant integration verifying, on re-auth, that a new
// credential belongs to the SAME account). Returns ONLY the account id — never
// email/plan or any other PII — so a `read`-scoped API token can confirm which
// account it belongs to without the wider exposure that /me carries. The id is
// the stable, non-secret Mongo ObjectId (already sent to the frontend via
// user.toJSON()). req.user.id is set on both auth paths (JWT and API token).
router.get('/whoami', requireAuth, (req, res) => {
  res.json({ id: req.user.id });
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
      await equalizeLookupTiming(); // L-8: match the found-branch write cost
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

  // typeof on the token for the same reason as /verify-email (L-2). `password`
  // needs no guard here — Mongoose casts/validates it and answers 400.
  if (typeof token !== 'string' || !token || !password) {
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
    revokeAllSessions(user); // Invalidate all existing device sessions
    eventBus.dropUser(user._id); // and force-close open SSE event streams
    // Successful password reset is the user's explicit recovery signal —
    // clear any brute-force lockout state too. Otherwise a locked user
    // would still be locked after resetting their password.
    resetLoginAttempts(user);

    await user.save();
    // Revoke connected AI assistants (OAuth consent grants): a password reset
    // is the user's explicit account-recovery signal, so a phished third-party
    // grant must not survive it (security report 2026-08-27). Personal API
    // tokens (HA, climate) carry a null oauthClientId and keep PAT semantics.
    const revokedConnections = await revokeOAuthConnectionsForUser(user._id);

    logAudit(req, 'auth.password_reset',
      { type: 'user', id: user._id },
      { username: user.username, oauthConnectionsRevoked: revokedConnections }
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
