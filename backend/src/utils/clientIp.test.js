const { getClientIp } = require('./clientIp');

const REAL_USER     = '54.123.45.67';
const CF_EDGE_IP    = '173.245.50.1';   // inside 173.245.48.0/20
const CF_EDGE_IPV6  = '2606:4700::1';
const ATTACKER_IP   = '116.202.5.10';   // Hetzner-style, NOT in any CF range

describe('getClientIp', () => {
  it('returns CF-Connecting-IP when req.ip is a Cloudflare edge (the happy path)', () => {
    const req = {
      ip: CF_EDGE_IP,
      headers: { 'cf-connecting-ip': REAL_USER },
    };
    expect(getClientIp(req)).toBe(REAL_USER);
  });

  it('IGNORES a spoofed CF-Connecting-IP when req.ip is NOT Cloudflare (the bypass we are blocking)', () => {
    // Attacker hits Hetzner origin directly, sets header to anything.
    // Pre-fix, this returned the attacker-chosen value and bypassed every limiter.
    const req = {
      ip: ATTACKER_IP,
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    };
    expect(getClientIp(req)).toBe(ATTACKER_IP);
  });

  it('falls back to req.ip when no CF header is present', () => {
    const req = {
      ip: CF_EDGE_IP,
      headers: {},
    };
    expect(getClientIp(req)).toBe(CF_EDGE_IP);
  });

  it('handles a missing headers object', () => {
    const req = { ip: ATTACKER_IP };
    expect(getClientIp(req)).toBe(ATTACKER_IP);
  });

  it('takes the leftmost IP from a comma-separated CF header (defensive)', () => {
    const req = {
      ip: CF_EDGE_IP,
      headers: { 'cf-connecting-ip': `${REAL_USER}, 1.1.1.1` },
    };
    expect(getClientIp(req)).toBe(REAL_USER);
  });

  it('honours CF-Connecting-IP via an IPv4-mapped IPv6 req.ip (dual-stack socket)', () => {
    const req = {
      ip: '::ffff:173.245.50.1',
      headers: { 'cf-connecting-ip': REAL_USER },
    };
    expect(getClientIp(req)).toBe(REAL_USER);
  });

  it('honours CF-Connecting-IP via an IPv6 CF edge', () => {
    const req = {
      ip: CF_EDGE_IPV6,
      headers: { 'cf-connecting-ip': REAL_USER },
    };
    expect(getClientIp(req)).toBe(REAL_USER);
  });

  it('returns undefined when req.ip is undefined (no IP to validate against)', () => {
    const req = {
      ip: undefined,
      headers: { 'cf-connecting-ip': REAL_USER },
    };
    expect(getClientIp(req)).toBeUndefined();
  });

  it('handles req being null gracefully', () => {
    expect(getClientIp(null)).toBeFalsy();
  });

  it('handles req with no headers and no ip', () => {
    expect(getClientIp({})).toBeUndefined();
  });

  // Pre-existing regression: 172.69.x.x is inside the CF 172.64.0.0/13 range,
  // so this case behaves identically to the spec test on the same input.
  it('still trusts CF-Connecting-IP when req.ip is in 172.64.0.0/13 (existing pattern)', () => {
    const req = { headers: { 'cf-connecting-ip': '1.2.3.4' }, ip: '172.69.0.1' };
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  // Pre-existing regression: private IPs are not CF, so any header is ignored.
  it('ignores CF-Connecting-IP when req.ip is a private/internal address', () => {
    const req = { headers: { 'cf-connecting-ip': '1.2.3.4' }, ip: '192.168.1.50' };
    expect(getClientIp(req)).toBe('192.168.1.50');
  });
});
