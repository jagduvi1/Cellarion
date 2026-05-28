const { isCloudflareIP } = require('./cloudflareIps');

/**
 * Returns the real client IP address used for rate-limit keys and audit logs.
 *
 * Cellarion runs behind Cloudflare → Traefik → nginx → backend. The trust
 * model on this hop chain is:
 *
 *   - `req.ip` is resolved by Express against `trust proxy = 2`. With our
 *     chain, that means req.ip is the Cloudflare edge IP for requests that
 *     actually came through Cloudflare, and the attacker's IP for requests
 *     that hit the Hetzner origin directly (bypassing CF).
 *   - The CF-Connecting-IP header is only set by Cloudflare itself, but the
 *     header can be spoofed by anyone hitting the origin directly. Trusting
 *     it unconditionally — as an earlier version did — turned every rate
 *     limiter (login, password reset, /api/chat) into a no-op for anyone
 *     willing to rotate the header value per request.
 *
 * Fix: only honour CF-Connecting-IP when req.ip is itself inside Cloudflare's
 * published edge IP range. Real users via Cloudflare get their real IP. Direct
 * attackers fall through to req.ip (their actual source) and are correctly
 * rate-limited on it.
 */
function getClientIp(req) {
  const cfHeader = req && req.headers && req.headers['cf-connecting-ip'];
  if (cfHeader && isCloudflareIP(req.ip)) {
    // CF sends a single IP, but split defensively in case any upstream
    // proxy appends to it.
    return String(cfHeader).split(',')[0].trim();
  }
  return req && req.ip;
}

module.exports = { getClientIp };
