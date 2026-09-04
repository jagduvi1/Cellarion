const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const crypto = require('crypto');
const User = require('../models/User');
const { logAudit } = require('../services/audit');
const { issueTokens, clientHint } = require('../services/authTokens');
const { resolvePendingShares } = require('../services/pendingShares');
const { CookieStateStore } = require('../services/oauthStateStore');

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
 * Turn a set of provider-neutral SSO claims into a Cellarion account, three ways:
 *   1. already linked by (provider, providerId)  → return it
 *   2. existing account with the same (verified) email → link this provider to it
 *   3. otherwise → create a fresh SSO account
 * Then downstream everything (roles, plans, refresh rotation, cellar shares)
 * behaves exactly like a password account.
 *
 * `claims` is normalised by the caller so this stays provider-agnostic:
 *   { providerId, email, emailVerified, displayName }
 *
 * `trustEmailVerified` decides whether an unverified email may still link:
 *   - Google is an OPEN issuer — anyone can hold an account there, so an
 *     unverified address is an attacker-controlled claim and must never link.
 *     The Google adapter passes false and relies on Google's own verification.
 *   - A self-hosted OIDC issuer is not open — the operator decides who gets an
 *     account at all, so "do I trust this issuer's email claim" is a real
 *     question only they can answer. OIDC_TRUST_EMAIL_VERIFIED (default off) is
 *     where they answer it; when true this is passed true and the address is
 *     treated as verified even if the issuer does not assert it.
 */
async function upsertSsoUser(provider, claims, { trustEmailVerified = false } = {}) {
  const { providerId, displayName } = claims;
  const email = claims.email ? claims.email.toLowerCase() : null;
  const emailVerified = claims.emailVerified === true || trustEmailVerified === true;

  // 1. Already linked?
  const linked = await User.findOne({
    'authProviders.provider': provider,
    'authProviders.providerId': providerId
  });
  if (linked) return linked;

  if (!email || !emailVerified) {
    const err = new Error('The identity provider did not supply a verified email address.');
    err.code = 'no_verified_email';
    throw err;
  }

  // 2. Existing account with this email → link this provider to it.
  const existing = await User.findOne({ email });
  if (existing) {
    existing.authProviders.push({ provider, providerId });
    if (!existing.emailVerified) existing.emailVerified = true; // provider-verified
    await existing.save();
    return existing;
  }

  // 3. Brand-new SSO account.
  const username = await generateUniqueUsername(email, displayName);
  const user = new User({
    username,
    email,
    emailVerified: true, // provider-verified
    roles: ['user'],
    displayName: displayName || undefined,
    authProviders: [{ provider, providerId }]
    // GDPR consent is intentionally NOT stamped here. A new SSO account lands
    // with requiresPolicyReconsent === true, and the app's ReconsentModal forces
    // the user to accept the privacy policy + data processing before using the
    // app — the same explicit, recorded consent the registration form captures.
  });
  await user.save();
  return user;
}

/**
 * Adapter: map a passport-google-oauth20 profile onto the neutral claim shape.
 * Google asserts email verification itself and is an open issuer, so it never
 * blanket-trusts — trustEmailVerified stays false and the email_verified claim
 * is authoritative. Behaviour is identical to the pre-refactor path.
 */
async function upsertGoogleUser(profile) {
  const emailEntry = Array.isArray(profile.emails) ? profile.emails[0] : null;
  return upsertSsoUser('google', {
    providerId: profile.id,
    email: emailEntry?.value || null,
    emailVerified: profile._json?.email_verified === true || emailEntry?.verified === true,
    displayName: profile.displayName
  }, { trustEmailVerified: false });
}

// One store instance serves every provider: it holds no per-flow state of its
// own, only the cookie name and lifetime.
const oauthStateStore = new CookieStateStore();

if (GOOGLE_ENABLED) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: CALLBACK_URL,
      // Bind the round trip to the browser that started it. Without a store,
      // passport-oauth2 uses its NullStore and the callback will exchange any
      // authorization code presented to it, which is login CSRF: an attacker
      // navigates a victim to the callback carrying a code for the ATTACKER's
      // Google account and the victim is signed into it. There is no session
      // middleware here to hold the state, so it rides in a short-lived
      // httpOnly cookie — see services/oauthStateStore.js.
      store: oauthStateStore,
      // PKCE binds the code to this flow's own verifier as well, so a code
      // intercepted in transit cannot be redeemed elsewhere. Separable from the
      // state fix above: the same store carries the verifier, and dropping this
      // line leaves the CSRF binding intact.
      pkce: 'S256'
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
  passport.authenticate('google', { session: false }, async (err, user, info) => {
    if (err || !user) {
      // The provider can bounce back with ?error=... — a cancelled consent
      // screen, most often — and passport-oauth2 answers that BEFORE it
      // consults the state store, so the outbound cookie is still in the
      // browser and verify() never ran. Clear it here: an abandoned flow has no
      // business leaving its state behind for the rest of its lifetime.
      oauthStateStore.clear(res);
      // info carries the state store's verdict; without it a failed browser
      // binding would be reported as a plain access_denied and look to the
      // operator like the user cancelling at the consent screen.
      const reason = err?.code || info?.code || (err ? 'server_error' : 'access_denied');
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
module.exports.upsertSsoUser = upsertSsoUser;
module.exports.upsertGoogleUser = upsertGoogleUser;
module.exports.generateUniqueUsername = generateUniqueUsername;
