/**
 * Returns the real client IP address.
 *
 * Prefers the Cloudflare-set CF-Connecting-IP header (cannot be spoofed when
 * traffic flows through Cloudflare). Falls back to req.ip for non-Cloudflare
 * environments (local dev, direct access).
 */
function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

module.exports = { getClientIp };
