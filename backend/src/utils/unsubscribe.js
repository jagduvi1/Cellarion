const crypto = require('crypto');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
const SECRET = process.env.JWT_SECRET;

// Tokens older than this are rejected (L-3). A link captured from a forwarded
// or archived email must not replay forever; 90 days comfortably outlives any
// legitimate inbox latency.
const TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Length of the truncated HMAC emitted before the full-digest upgrade (L-2).
const LEGACY_MAC_LENGTH = 16;

/**
 * Create a signed unsubscribe token: base64url(userId:timestamp:hmac).
 * The HMAC (full 64-hex SHA-256 digest) prevents token forgery — an attacker
 * cannot unsubscribe another user without knowing the server secret.
 */
function createUnsubscribeToken(userId) {
  const payload = `${userId}:${Date.now()}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

/**
 * Verify and extract userId from a signed unsubscribe token.
 * Returns the userId string if valid, or null if forged/malformed/expired.
 */
function verifyUnsubscribeToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [userId, timestamp, mac] = parts;

    // Expiry (L-3): the signed timestamp must parse and be within the window.
    const issuedAt = Number(timestamp);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > TOKEN_MAX_AGE_MS) return null;

    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(`${userId}:${timestamp}`)
      .digest('hex');

    // Backward compatibility (L-2): links in already-sent emails carry the old
    // 16-hex truncated MAC and must keep working until they age out. Accept the
    // legacy 16-char digest prefix ONLY when the provided MAC is exactly 16 hex
    // chars; everything else must match the full 64-hex digest. The 90-day
    // expiry above naturally retires legacy links — remove this branch (and its
    // tests) after 2026-10 when no pre-upgrade link can still be valid.
    const reference = /^[0-9a-f]{16}$/.test(mac)
      ? expected.slice(0, LEGACY_MAC_LENGTH)
      : expected;

    const macBuf = Buffer.from(mac);
    const refBuf = Buffer.from(reference);
    if (macBuf.length !== refBuf.length || !crypto.timingSafeEqual(macBuf, refBuf)) return null;

    return userId;
  } catch {
    return null;
  }
}

/**
 * A SCOPED unsubscribe token turns off one category only (the support-reply
 * email links "stop emailing me answers" next to "unsubscribe from all").
 * base64url(userId:timestamp:scope:hmac), the HMAC over all three fields — so
 * it is four parts where the all-categories token is three, and neither kind
 * verifies as the other: an all-token can't be replayed on a scoped link, and
 * a scoped token can't unsubscribe someone from everything.
 */
const UNSUBSCRIBE_SCOPES = ['supportReply'];

function createScopedUnsubscribeToken(userId, scope) {
  if (!UNSUBSCRIBE_SCOPES.includes(scope)) throw new Error(`Unknown unsubscribe scope: ${scope}`);
  const payload = `${userId}:${Date.now()}:${scope}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

/** userId when `token` is a valid, unexpired token for exactly `scope`; else null. */
function verifyScopedUnsubscribeToken(token, scope) {
  try {
    if (typeof token !== 'string' || !UNSUBSCRIBE_SCOPES.includes(scope)) return null;
    const parts = Buffer.from(token, 'base64url').toString().split(':');
    if (parts.length !== 4) return null;
    const [userId, timestamp, tokenScope, mac] = parts;
    if (tokenScope !== scope) return null;
    const issuedAt = Number(timestamp);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > TOKEN_MAX_AGE_MS) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(`${userId}:${timestamp}:${tokenScope}`).digest('hex');
    const macBuf = Buffer.from(mac);
    const refBuf = Buffer.from(expected);
    if (macBuf.length !== refBuf.length || !crypto.timingSafeEqual(macBuf, refBuf)) return null;
    return userId;
  } catch {
    return null;
  }
}

module.exports = {
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  createScopedUnsubscribeToken,
  verifyScopedUnsubscribeToken,
  UNSUBSCRIBE_SCOPES,
};
