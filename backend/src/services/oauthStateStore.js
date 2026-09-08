const crypto = require('crypto');
const { COOKIE_SECURE } = require('./authTokens');

/**
 * Per-flow OAuth state (and PKCE code verifier) held in a short-lived httpOnly
 * cookie, implementing the passport-oauth2 state-store interface.
 *
 * WHY A CUSTOM STORE RATHER THAN THE BUILT-IN ONES:
 * passport-oauth2 ships session-backed stores, and this backend runs no session
 * middleware at all — it mints its own JWT plus refresh cookie and calls
 * passport with { session: false }. With neither `store` nor `state` set,
 * passport-oauth2 falls back to its NullStore, which verifies nothing: the
 * callback then accepts any authorization code it is handed, so the flow is not
 * bound to the browser that began it. A cookie restores that binding without
 * introducing server-side session state, and is the same shape a second
 * provider (OIDC) needs.
 *
 * sameSite:'lax' is required rather than preferred. The callback arrives as a
 * top-level GET navigation from the identity provider — a cross-site request —
 * which 'lax' permits and 'strict' would drop, failing every sign-in at
 * verification. Same reasoning as the refresh cookie in authTokens.js.
 *
 * WHAT THIS DOES AND DOES NOT DEFEND. It binds the callback to the browser that
 * started the flow, which is what closes login CSRF / session swapping. It is
 * not a defence against an attacker who can already write cookies for this
 * origin (a subdomain foothold, say): such an attacker can plant a genuine
 * cookie/state pair taken from their own flow, and no double-submit scheme —
 * signed or not — survives that. Signing the value would therefore buy nothing
 * here, which is why it is a plain random value rather than an HMAC.
 */

const DEFAULT_COOKIE_NAME = 'oauthState';
const DEFAULT_TTL_MS = 10 * 60 * 1000; // long enough for a consent screen, short enough to expire an abandoned one

// Path-scoped like the refresh cookie: the only endpoint that ever reads it is
// /api/auth/<provider>/callback, so it has no business riding on API calls,
// uploads or SSE.
const COOKIE_PATH = '/api/auth';

const encode = (buf) => buf.toString('base64url');

/** Constant-time comparison that tolerates unequal lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class CookieStateStore {
  constructor({ cookieName = DEFAULT_COOKIE_NAME, ttlMs = DEFAULT_TTL_MS, secure = COOKIE_SECURE } = {}) {
    this.cookieName = cookieName;
    this.ttlMs = ttlMs;
    this.cookieBase = {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: COOKIE_PATH
    };
  }

  /**
   * Called on the way OUT, before the redirect to the provider. The five-argument
   * arity is the PKCE-aware one: passport-oauth2 generates `verifier` when the
   * strategy sets `pkce`, and hands it here to persist. `meta` is unused — the
   * cookie is already scoped to this deployment's own origin and path.
   *
   * Returns the state value to put on the authorization request.
   */
  store(req, verifier, state, meta, callback) {
    let value;
    try {
      value = encode(crypto.randomBytes(32));
      // state . issuedAt . verifier — the verifier half is empty when PKCE is off.
      const payload = [value, Date.now(), verifier || ''].join('.');
      req.res.cookie(this.cookieName, payload, { ...this.cookieBase, maxAge: this.ttlMs });
    } catch (err) {
      return callback(err);
    }
    return callback(null, value);
  }

  /**
   * Called on the way BACK, before the authorization code is exchanged.
   *
   * The cookie is consumed whether verification passes or fails: a failed
   * attempt that left it behind would let a stale flow be completed later. Note
   * the limit of "whatever the outcome" — passport-oauth2 answers a provider
   * error (?error=access_denied and friends) before it ever reaches this
   * method, so routes/oauth.js clears the cookie on its failure path too.
   *
   * Single-use here means the browser is not asked for it twice; the server
   * keeps no record of spent states, so it is not a replay ledger. It does not
   * need to be one — an authorization code is single-use at the provider, so a
   * replayed pair fails at the token exchange instead.
   *
   * Returning the verifier as the `ok` value is how passport-oauth2 picks up
   * code_verifier for the token request (a string `ok` means PKCE); `true` is
   * the non-PKCE success value.
   */
  verify(req, state, callback) {
    const raw = req.cookies ? req.cookies[this.cookieName] : undefined;
    this.clear(req.res);

    if (!raw || !state) return callback(null, false, { code: 'invalid_state' });

    const [expected, issuedAt, verifier] = String(raw).split('.');
    if (!expected || !safeEqual(expected, state)) {
      return callback(null, false, { code: 'invalid_state' });
    }

    // Belt to the cookie's own maxAge: a browser that kept it beyond its life
    // (or a value replayed by hand) is still refused. This check can only ever
    // reject — an attacker editing their own cookie cannot make a mismatched
    // state match — so it needs no integrity protection.
    const age = Date.now() - Number(issuedAt);
    if (!Number.isFinite(age) || age < 0 || age > this.ttlMs) {
      return callback(null, false, { code: 'invalid_state' });
    }

    return callback(null, verifier || true);
  }

  /** Delete the cookie. Safe to call when none was set. */
  clear(res) {
    if (res && typeof res.clearCookie === 'function') {
      // No maxAge: passing one makes Express re-derive a future expiry and
      // leaves an empty cookie behind instead of deleting it (authTokens.js
      // learned this the same way).
      res.clearCookie(this.cookieName, this.cookieBase);
    }
  }
}

module.exports = { CookieStateStore, DEFAULT_COOKIE_NAME, DEFAULT_TTL_MS };
