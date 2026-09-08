const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const OAuth2Strategy = require('passport-oauth2').Strategy;
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

// The same opt-in shape for a generic OIDC provider, so a self-hoster can point
// Cellarion at their own identity provider instead of Google (#1203). Nothing
// here is Google-specific and nothing changes for a deployment that leaves
// these unset — there is no mode flag and no either/or: both can be on.
//
// WHY passport-oauth2 AND NOT passport-openidconnect. It adds no dependency
// (passport-google-oauth20 is already a passport-oauth2 wrapper), and the state
// store below implements passport-oauth2's store interface — so this strategy
// inherits the browser binding and PKCE by passing the same `store`, rather
// than needing a second mechanism for the same job.
//
// WHY THREE URLs RATHER THAN ONE ISSUER + DISCOVERY. Strategies register at
// require time on config presence. A discovery fetch at that moment makes SSO
// depend on the provider being reachable during boot, and its absence is
// silent: the strategy simply never registers and the login button never
// appears. Explicit endpoints cannot fail that way. They come straight off the
// provider's /.well-known/openid-configuration, once, by hand.
const OIDC_ENABLED = Boolean(
  process.env.OIDC_CLIENT_ID &&
  process.env.OIDC_CLIENT_SECRET &&
  process.env.OIDC_ISSUER &&
  process.env.OIDC_AUTHORIZATION_URL &&
  process.env.OIDC_TOKEN_URL &&
  process.env.OIDC_USERINFO_URL
);

// Label for the login button. Providers are named things to their users
// ("Continue with Pocket ID"), and "Continue with OIDC" is jargon on a page
// where the other button says Google.
const OIDC_PROVIDER_NAME = process.env.OIDC_PROVIDER_NAME || 'SSO';

// Identifier for the issuer that mints the subjects we store. Part of the
// account key, not decoration: OIDC guarantees `sub` unique only within an
// issuer, so without this, repointing a deployment at a different provider or
// realm would let a different person holding the same subject value inherit an
// existing local account.
//
// REQUIRED, and copied verbatim from the `issuer` field of the provider's
// /.well-known/openid-configuration. It is deliberately NOT derived from the
// authorization URL: there is no rule that maps one to the other. Keycloak
// appends /protocol/openid-connect/auth to its issuer, Pocket ID appends
// /authorize, Authentik /application/o/authorize/ — so taking the URL's origin
// is right for some providers and wrong for others. Wrong in the worst way for
// Keycloak, whose issuer carries the realm: every realm on one host shares an
// origin, so two realms would collapse to the same identifier and a subject
// reused across them would land on the existing account. Being a whole path
// segment rather than a hostname, that is exactly the case an origin cannot
// distinguish.
const OIDC_ISSUER = process.env.OIDC_ISSUER || null;

// Whether an unverified email from this issuer may link to an existing local
// account. Default OFF — see the adapter below for why this is the operator's
// answer to give and not ours.
const OIDC_TRUST_EMAIL_VERIFIED = process.env.OIDC_TRUST_EMAIL_VERIFIED === 'true';

// `openid` is not optional even though nothing here reads an ID token: the
// userinfo endpoint is an OIDC feature and providers refuse it without that
// scope. `profile` and `email` carry the claims the account resolver needs.
const OIDC_SCOPES = (process.env.OIDC_SCOPES || 'openid profile email').split(/[\s,]+/).filter(Boolean);

const trimSlash = (s) => (s || '').replace(/\/$/, '');
const frontendBase = trimSlash(process.env.FRONTEND_URL) || 'http://localhost:3000';

// Where Google sends the browser back after consent. Must EXACTLY match an
// "Authorized redirect URI" on the Google OAuth client. The API is served under
// the same origin as the SPA (nginx proxies /api → backend), so we derive it
// from FRONTEND_URL. Override with GOOGLE_CALLBACK_URL when the API lives on a
// different host (e.g. local dev with a separate backend port).
const CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `${frontendBase}/api/auth/google/callback`;
const OIDC_CALLBACK_URL = process.env.OIDC_CALLBACK_URL || `${frontendBase}/api/auth/oidc/callback`;

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
async function upsertSsoUser(provider, claims, { trustEmailVerified = false, issuer = null } = {}) {
  const { providerId, displayName } = claims;
  const email = claims.email ? claims.email.toLowerCase() : null;
  const emailVerified = claims.emailVerified === true || trustEmailVerified === true;

  // The identity this sign-in asserts. `issuer` is part of it for OIDC because
  // the spec only guarantees `sub` to be unique WITHIN an issuer: repoint a
  // deployment at another provider or realm and a different person holding the
  // same subject would otherwise inherit this account. Google needs none — it
  // is a single fixed issuer, so the provider name already says which.
  const identity = { provider, providerId };
  if (issuer) identity.issuer = issuer;

  // 1. Already linked?
  //
  // $elemMatch, NOT two dotted conditions. Dotted paths into an array of
  // subdocuments are matched INDEPENDENTLY: each condition may be satisfied by
  // a different element, so an account holding google/123 and oidc/456 is
  // returned for a query for oidc/123 — an identity nobody has ever linked, and
  // the match happens before the email checks below. $elemMatch requires all
  // conditions to hold within one element, which is the actual question.
  const linked = await User.findOne({ authProviders: { $elemMatch: identity } });
  if (linked) return linked;

  if (!email || !emailVerified) {
    const err = new Error('The identity provider did not supply a verified email address.');
    err.code = 'no_verified_email';
    throw err;
  }

  // 2. Existing account with this email → link this provider to it.
  const existing = await User.findOne({ email });
  if (existing) {
    existing.authProviders.push({ ...identity });
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
    authProviders: [{ ...identity }]
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

/**
 * Adapter: map OIDC userinfo claims onto the neutral claim shape.
 *
 * `sub` is the only claim guaranteed stable and unique per issuer, so it is the
 * provider id; email can change and is never the key. Display name falls back
 * through the claims providers actually populate.
 *
 * trustEmailVerified is the operator's decision, not ours, which is why it is a
 * variable and not a constant. Google's hard email_verified check exists
 * because Google is an OPEN issuer: anyone can hold an account there, so an
 * unverified address is an attacker-controlled claim and linking on it would
 * hand over an existing local account. A self-hosted issuer is not that — its
 * operator decides who gets an account at all — so whether its email claim is
 * trustworthy is a real question with a real answer, and only they can give it.
 * Default off keeps the safe behaviour for anyone who never thinks about it.
 */
async function upsertOidcUser(claims) {
  return upsertSsoUser('oidc', {
    providerId: claims.sub,
    email: claims.email || null,
    emailVerified: claims.email_verified === true,
    displayName: claims.name || claims.display_name || claims.preferred_username
  }, { trustEmailVerified: OIDC_TRUST_EMAIL_VERIFIED, issuer: OIDC_ISSUER });
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
}

if (OIDC_ENABLED) {
  const oidcStrategy = new OAuth2Strategy(
    {
      authorizationURL: process.env.OIDC_AUTHORIZATION_URL,
      tokenURL: process.env.OIDC_TOKEN_URL,
      clientID: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      callbackURL: OIDC_CALLBACK_URL,
      // Same store instance as Google: one cookie name, one lifetime, and the
      // binding that stops an authorization code minted in one browser being
      // redeemed in another. Passing it is the whole of what this strategy has
      // to do to inherit that.
      store: oauthStateStore,
      pkce: 'S256'
    },
    async (accessToken, refreshToken, claims, done) => {
      try {
        return done(null, await upsertOidcUser(claims));
      } catch (err) {
        return done(err);
      }
    }
  );

  /**
   * Where the identity comes from — and, deliberately, where it does not.
   *
   * passport-oauth2 has no profile of its own, so we fetch the claims from the
   * provider's userinfo endpoint with the access token we were just issued.
   * That request is a direct, TLS-protected, client-authenticated back channel
   * to the provider, which is what makes its answer trustworthy.
   *
   * The token response also carries an `id_token`, because `openid` is in the
   * requested scopes. NOTHING HERE READS IT, and that is a decision rather than
   * an oversight: an ID token is only worth anything once its signature, issuer,
   * audience and expiry have been verified against the provider's JWKS, and a
   * half-done version of that — decoding the JWT and trusting its claims — is a
   * complete authentication bypass, since anyone can mint an unsigned JWT.
   * Using userinfo instead means there is no token to verify and no way to get
   * that wrong. If ID-token claims are ever wanted here, verify them properly or
   * not at all; do not split the difference.
   *
   * `nonce` is absent for the same reason: it defends against ID-token replay,
   * and no ID token is consumed. Browser binding is `state`, which the store
   * above provides, plus PKCE on the code itself.
   */
  // Send the access token as `Authorization: Bearer`, not as a query parameter.
  // node-oauth defaults this OFF, so `_oauth2.get()` would otherwise append
  // ?access_token=… to the userinfo URL: providers reject that (the OIDC spec
  // has clients use the header), and a token in a URL is the kind of thing that
  // ends up in access logs and proxy history. passport-google-oauth20 never
  // trips over this because it does not use this code path.
  oidcStrategy._oauth2.useAuthorizationHeaderforGET(true);

  oidcStrategy.userProfile = function userProfile(accessToken, done) {
    this._oauth2.get(process.env.OIDC_USERINFO_URL, accessToken, (err, body) => {
      // Report the status, never the body: a provider's error response can echo
      // the access token back, and this ends up in logs.
      if (err) return done(new Error(`Failed to fetch OIDC userinfo (HTTP ${err.statusCode || 'error'})`));
      let claims;
      try {
        claims = JSON.parse(body);
      } catch (e) {
        return done(new Error('OIDC userinfo was not JSON'));
      }
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
        // Without `sub` there is no stable identity to key an account on, and
        // falling back to email would key it on something the user can change.
        return done(new Error('OIDC userinfo carried no sub claim'));
      }
      return done(null, claims);
    });
  };

  passport.use('oidc', oidcStrategy);
}

// Stateless: we mint our own JWT + refresh cookie, so passport keeps no
// session. Registered for EITHER provider rather than only inside the Google
// block, so an OIDC-only deployment is set up the same way a Google one is.
// Defensive rather than load-bearing: passport 0.7 tolerates authenticate()
// without initialize() when sessions are off, so the old placement works today
// — but that is undocumented tolerance, not a promise.
if (GOOGLE_ENABLED || OIDC_ENABLED) {
  router.use(passport.initialize());
}

// GET /api/auth/sso/providers — public. Lets the login page render only the
// SSO buttons that are actually configured on this deployment.
router.get('/sso/providers', (req, res) => {
  // oidcName travels with the flag because the button needs the provider's own
  // name to be worth showing: "Continue with OIDC" means nothing to the person
  // reading it.
  res.json({ google: GOOGLE_ENABLED, oidc: OIDC_ENABLED, oidcName: OIDC_PROVIDER_NAME });
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

// GET /api/auth/oidc — start the redirect to the configured OIDC provider.
// Deliberately no `prompt` equivalent to Google's select_account: an issuer's
// re-authentication policy is the operator's to set, not ours to override.
router.get('/oidc', (req, res, next) => {
  if (!OIDC_ENABLED) return res.redirect(failureRedirect('not_configured'));
  passport.authenticate('oidc', {
    scope: OIDC_SCOPES,
    session: false
  })(req, res, next);
});

// GET /api/auth/oidc/callback — the provider redirects here after consent.
// Identical handling to the Google callback, including the state-cookie
// cleanup: passport-oauth2 answers a provider `?error=...` BEFORE it consults
// the state store, so a cancelled sign-in would otherwise leave its state in
// the browser for the rest of the cookie's life.
router.get('/oidc/callback', (req, res, next) => {
  if (!OIDC_ENABLED) return res.redirect(failureRedirect('not_configured'));
  passport.authenticate('oidc', { session: false }, async (err, user, info) => {
    if (err || !user) {
      oauthStateStore.clear(res);
      const reason = err?.code || info?.code || (err ? 'server_error' : 'access_denied');
      logAudit(req, 'auth.oauth.failed', {}, { provider: 'oidc', reason });
      return res.redirect(failureRedirect(reason));
    }
    try {
      await issueTokens(user, res, { rememberMe: true, client: clientHint(req) });
      logAudit(req, 'auth.oauth.success', { type: 'user', id: user._id }, { provider: 'oidc' });
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
module.exports.upsertOidcUser = upsertOidcUser;
module.exports.generateUniqueUsername = generateUniqueUsername;
