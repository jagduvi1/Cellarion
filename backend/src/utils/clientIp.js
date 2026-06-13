const net = require('net');
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

/**
 * Collapse an IPv6 address to its /64 network prefix for use as a rate-limit
 * key. A single client is routinely assigned a whole /64, so keying on the full
 * /128 lets them rotate the low 64 bits to get a fresh bucket every request and
 * defeat per-IP throttling. IPv4 (and IPv4-mapped) addresses are returned
 * unchanged. Returns a stable key string (not necessarily a valid address).
 */
function maskIpForRateLimit(ip) {
  if (!ip || typeof ip !== 'string') return ip;
  const bare = ip.split('%')[0]; // strip any zone id
  if (net.isIP(bare) !== 6 || bare.includes('.')) return ip; // IPv4 / v4-mapped → keep full

  const [headStr, tailStr] = bare.split('::');
  const head = headStr ? headStr.split(':') : [];
  let groups;
  if (tailStr === undefined) {
    groups = head; // no '::' compression — already 8 groups
  } else {
    const tail = tailStr ? tailStr.split(':') : [];
    const missing = Math.max(0, 8 - head.length - tail.length);
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  const prefix = groups.slice(0, 4).map(g => (parseInt(g || '0', 16) || 0).toString(16)).join(':');
  return `${prefix}::/64`;
}

/**
 * Rate-limit key: the client IP, with IPv6 collapsed to /64. Use this for every
 * per-IP express-rate-limit keyGenerator. (Audit logs keep full precision via
 * getClientIp.)
 */
function rateLimitKey(req) {
  return maskIpForRateLimit(getClientIp(req));
}

module.exports = { getClientIp, rateLimitKey, maskIpForRateLimit };
