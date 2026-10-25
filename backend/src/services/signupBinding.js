/**
 * Signup binding — lets the email-verification link sign a new member in,
 * but only in the browser that registered the account.
 *
 * Verification itself issues no session by default (security audit M-1): a
 * session-issuing verify step is a login-CSRF hole, because an attacker can
 * register an account, take its verification link and get a victim's browser
 * to open it — the victim is then silently signed in to the attacker's account
 * and saves their cellar into it. The binding closes that: registration drops
 * an httpOnly cookie holding an HMAC of the new account's id, and the verify
 * step signs in only when the request carries the cookie for THAT account. An
 * attacker cannot place an httpOnly cookie in someone else's browser, so their
 * link only ever verifies, and the member opening it in another browser (a
 * mail app's own browser, another device) signs in normally, as before.
 *
 * The cookie is SameSite=Strict and scoped to /api/auth: it rides only on the
 * same-origin POST the verify page makes, never on a cross-site request. It
 * lives as long as a verification link can still be sent again (resend), and
 * is cleared once the email is verified.
 */
const crypto = require('crypto');
const { COOKIE_SECURE } = require('./authTokens');

const COOKIE_NAME = 'signupBinding';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const cookieBase = { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', path: '/api/auth' };

function bindingFor(userId) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`signup-binding:${String(userId)}`)
    .digest('hex');
}

/** Mark this browser as the one that registered `userId`. */
function setSignupBinding(res, userId) {
  res.cookie(COOKIE_NAME, bindingFor(userId), { ...cookieBase, maxAge: MAX_AGE_MS });
}

/** Whether the request comes from the browser that registered `userId`. */
function hasSignupBinding(req, userId) {
  const got = req.cookies?.[COOKIE_NAME];
  if (typeof got !== 'string' || !got) return false;
  const want = bindingFor(userId);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function clearSignupBinding(res) {
  res.clearCookie(COOKIE_NAME, cookieBase);
}

module.exports = { setSignupBinding, hasSignupBinding, clearSignupBinding, COOKIE_NAME };
