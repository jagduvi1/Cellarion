const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'fallback-dev-secret';

/**
 * Create a signed unsubscribe token: base64url(userId:timestamp:hmac).
 * The HMAC prevents token forgery — an attacker cannot unsubscribe
 * another user without knowing the server secret.
 */
function createUnsubscribeToken(userId) {
  const payload = `${userId}:${Date.now()}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 16);
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

/**
 * Verify and extract userId from a signed unsubscribe token.
 * Returns the userId string if valid, or null if forged/invalid.
 */
function verifyUnsubscribeToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length < 3) return null;

    const hmac = parts.pop();
    const payload = parts.join(':'); // userId:timestamp (userId may contain colons in theory)
    const [userId] = parts;

    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 16);
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;

    return userId;
  } catch {
    return null;
  }
}

module.exports = { createUnsubscribeToken, verifyUnsubscribeToken };
