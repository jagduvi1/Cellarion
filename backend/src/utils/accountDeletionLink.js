const crypto = require('crypto');
const { siteBaseUrl } = require('./siteUrl');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
const SECRET = process.env.JWT_SECRET;

// A "delete my account" link in an email is good for 14 days. It never deletes
// anything by itself: it opens a page that says what will go, and only the
// button there schedules the deletion (the usual 7 days to change your mind).
const TOKEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PURPOSE = 'deleteAccount';

// The HMAC covers a purpose label as well as the payload, so this token and
// the unsubscribe tokens (utils/unsubscribe) can never stand in for each other
// even though they share the server secret.
const mac = (payload) => crypto.createHmac('sha256', SECRET).update(`account-deletion-link:${payload}`).digest('hex');

/** base64url(userId:timestamp:deleteAccount:hmac) */
function createDeleteAccountToken(userId) {
  const payload = `${userId}:${Date.now()}:${PURPOSE}`;
  return Buffer.from(`${payload}:${mac(payload)}`).toString('base64url');
}

/** The userId when `token` is a valid, unexpired delete-account token; else null. */
function verifyDeleteAccountToken(token) {
  try {
    if (typeof token !== 'string' || !token) return null;
    const parts = Buffer.from(token, 'base64url').toString().split(':');
    if (parts.length !== 4) return null;
    const [userId, timestamp, purpose, given] = parts;
    if (purpose !== PURPOSE) return null;
    const issuedAt = Number(timestamp);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > TOKEN_MAX_AGE_MS) return null;
    const expected = Buffer.from(mac(`${userId}:${timestamp}:${purpose}`));
    const provided = Buffer.from(given);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
    return userId;
  } catch {
    return null;
  }
}

/** The page an email links to: `${site}/delete-account?token=…`. */
function deleteAccountLink(userId) {
  return `${siteBaseUrl()}/delete-account?token=${encodeURIComponent(createDeleteAccountToken(userId))}`;
}

module.exports = { createDeleteAccountToken, verifyDeleteAccountToken, deleteAccountLink, TOKEN_MAX_AGE_MS };
