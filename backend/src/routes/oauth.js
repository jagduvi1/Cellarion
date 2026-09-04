const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const crypto = require('crypto');
const User = require('../models/User');
const { logAudit } = require('../services/audit');
const { issueTokens, clientHint } = require('../services/authTokens');
const { resolvePendingShares } = require('../services/pendingShares');

const router = express.Router();

// SSO is opt-in per deployment: the strategy only registers, and the routes
// only work, when both Google credentials are present. Self-hosters without a
// Google OAuth client keep classic email+password login untouched.
const GOOGLE_ENABLED = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const trimSlash = (s) => (s || '').replace(/\/$/, '');
const frontendBase = trimSlash(process.env.FRONTEND_URL) || 'http://localhost:3000';

// Where Google sends the browser back after consent. Must EXACTLY match an
// "Authorized redirect URI" on the Google OAuth client. The API is served under
// the same origin as the SPA (nginx proxies /api → backend), so we derive it
// from FRONTEND_URL. Override with GOOGLE_CALLBACK_URL when the API lives on a
// different host (e.g. local dev with a separate backend port).
const CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `${frontendBase}/api/auth/google/callback`;

// Frontend landing route for the OAuth round-trip. On success the SPA restores
// the session from the refresh cookie; on failure it shows a message.
const successRedirect = `${frontendBase}/login/callback`;
const failureRedirect = (reason) => `${frontendBase}/login/callback?error=${encodeURIComponent(reason)}`;

/**
 * Derive a unique, schema-valid username (3–30 chars, [a-z0-9_.-], lowercase)
 * from the email local-part or display name, appending a short random suffix on
 * collision so first-time SSO users always get a usable handle.
 */
async function generateUniqueUsername(email, displayName) {
  const seed = email.split('@')[0] || displayName || 'user';
  let base = seed.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  if (base.length < 3) base = `${base}user`;
  base = base.slice(0, 24); // leave headroom for a suffix within the 30-char cap

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    const exists = await User.findOne({ username: candidate }).select('_id').lean();
    if (!exists) return candidate;
  }
  // Extremely unlikely fallback: base + longer random, still within 30 chars.
  return `${base}-${crypto.randomBytes(4).toString('hex')}`.slice(0, 30);
}

/**
 * Turn a Google profile into a Cellarion account, three ways:
 *   1. already linked by provider id  → return it
 *   2. existing account with the same (verified) email → link Google to it
 *   3. otherwise → create a fresh SSO account
 * Then downstream everything (roles, plans, refresh rotation, cellar shares)
 * behaves exactly like a password account.
 */
async function upsertGoogleUser(profile) {
  const providerId = profile.id;
  const emailEntry = Array.isArray(profile.emails) ? profile.emails[0] : null;
  const email = emailEntry?.value ? emailEntry.value.toLowerCase() : null;
  // Only trust the email once Google says it has verified ownership — otherwise
  // a Google account with an unverified address could be used to take over an
  // existing Cellarion account that happens to share that address.
  const emailVerified = profile._json?.email_verified === true || emailEntry?.verified === true;

  // 1. Already linked?
  const linked = await User.findOne({
    'authProviders.provider': 'google',
    'authProviders.providerId': providerId
  });
  if (linked) return linked;

  if (!email || !emailVerified) {
    const err = new Error('Google did not provide a verified email address.');
    err.code = 'no_verified_email';
    throw err;
  }

  // 2. Existing account with this email → link Google to it.
  const existing = await User.findOne({ email });
  if (existing) {
    existing.authProviders.push({ provider: 'google', providerId });
    if (!existing.emailVerified) existing.emailVerified = true; // Google verified it
    await existing.save();
    return existing;
  }

  // 3. Brand-new SSO account.
  const username = await generateUniqueUsername(email, profile.displayName);
  const user = new User({
    username,
    email,
    emailVerified: true, // provider-verified
    roles: ['user'],
    displayName: profile.displayName || undefined,
    authProviders: [{ provider: 'google', providerId }]
    // GDPR consent is intentionally NOT stamped here. A new SSO account lands
    // with requiresPolicyReconsent === true, and the app's ReconsentModal forces
    // the user to accept the privacy policy + data processing before using the
    // app — the same explicit, recorded consent the registration form captures.
  });
  await user.save();
  return user;
}

if (GOOGLE_ENABLED) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: CALLBACK_URL
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await upsertGoogleUser(profile);
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));
  // Stateless: we mint our own JWT + refresh cookie, so passport keeps no
  // session. initialize() is still required for passport.authenticate to run.
  router.use(passport.initialize());
}

// GET /api/auth/sso/providers — public. Lets the login page render only the
// SSO buttons that are actually configured on this deployment.
router.get('/sso/providers', (req, res) => {
  res.json({ google: GOOGLE_ENABLED });
});

// GET /api/auth/google — start the OAuth redirect to Google.
router.get('/google', (req, res, next) => {
  if (!GOOGLE_ENABLED) return res.redirect(failureRedirect('not_configured'));
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    prompt: 'select_account'
  })(req, res, next);
});

// GET /api/auth/google/callback — Google redirects here after consent. We use a
// custom callback so we control the redirect and never leak a token in the URL:
// on success we set the httpOnly refresh cookie and bounce to the SPA, which
// then calls /api/auth/refresh to obtain its access token.
router.get('/google/callback', (req, res, next) => {
  if (!GOOGLE_ENABLED) return res.redirect(failureRedirect('not_configured'));
  passport.authenticate('google', { session: false }, async (err, user) => {
    if (err || !user) {
      const reason = err?.code || (err ? 'server_error' : 'access_denied');
      logAudit(req, 'auth.oauth.failed', {}, { provider: 'google', reason });
      return res.redirect(failureRedirect(reason));
    }
    try {
      await issueTokens(user, res, { rememberMe: true, client: clientHint(req) });
      logAudit(req, 'auth.oauth.success', { type: 'user', id: user._id }, { provider: 'google' });
      resolvePendingShares(user).catch(() => {});
      return res.redirect(successRedirect);
    } catch (e) {
      console.error('OAuth token issue failed:', e);
      return res.redirect(failureRedirect('server_error'));
    }
  })(req, res, next);
});

module.exports = router;
// Exported for unit tests (the account-linking logic is the important part).
module.exports.upsertGoogleUser = upsertGoogleUser;
module.exports.generateUniqueUsername = generateUniqueUsername;
