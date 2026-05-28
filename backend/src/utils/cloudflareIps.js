const { BlockList, isIPv4, isIPv6 } = require('node:net');

/**
 * Published Cloudflare IP ranges — sourced from:
 *   https://www.cloudflare.com/ips-v4
 *   https://www.cloudflare.com/ips-v6
 *
 * Last verified: 2026-05. These ranges change about once every 3 years.
 * If legitimate Cloudflare-proxied requests start showing as rate-limited
 * on an unexpected IP, refresh both lists from the URLs above.
 *
 * Used by utils/clientIp.js to decide whether the CF-Connecting-IP header
 * is trustworthy on a given request. The bare check is also useful for
 * audit logging (flag mismatches between req.ip and CF-Connecting-IP).
 */
const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const blockList = new BlockList();
for (const range of CLOUDFLARE_IPV4_RANGES) {
  const [net, prefix] = range.split('/');
  blockList.addSubnet(net, Number(prefix), 'ipv4');
}
for (const range of CLOUDFLARE_IPV6_RANGES) {
  const [net, prefix] = range.split('/');
  blockList.addSubnet(net, Number(prefix), 'ipv6');
}

/**
 * @param {string} ip  IPv4 or IPv6 address (also accepts IPv4-mapped IPv6
 *                     forms like '::ffff:1.2.3.4' which Node uses on dual-
 *                     stack sockets).
 * @returns {boolean}  true iff `ip` falls inside a published Cloudflare range.
 *                     Non-string / malformed inputs return false (callers
 *                     get a safe "don't trust this request" outcome).
 */
function isCloudflareIP(ip) {
  if (typeof ip !== 'string' || !ip) return false;
  // Node's dual-stack sockets render IPv4 as '::ffff:1.2.3.4'. The
  // BlockList doesn't unwrap these for an IPv4 subnet match, so strip
  // the prefix first.
  let addr = ip;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (isIPv4(addr)) return blockList.check(addr, 'ipv4');
  if (isIPv6(addr)) return blockList.check(addr, 'ipv6');
  return false;
}

module.exports = { isCloudflareIP, CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES };
