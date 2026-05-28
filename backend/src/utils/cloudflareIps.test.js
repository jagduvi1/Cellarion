const { isCloudflareIP } = require('./cloudflareIps');

describe('isCloudflareIP', () => {
  describe('Cloudflare ranges (true)', () => {
    it('accepts a CF IPv4 in 173.245.48.0/20', () => {
      expect(isCloudflareIP('173.245.50.1')).toBe(true);
    });

    it('accepts a CF IPv4 in 104.16.0.0/13', () => {
      expect(isCloudflareIP('104.20.1.1')).toBe(true);
    });

    it('accepts a CF IPv4 at the lower boundary of a range', () => {
      expect(isCloudflareIP('103.21.244.0')).toBe(true);
    });

    it('accepts a CF IPv4 at the upper boundary of a range', () => {
      // 173.245.48.0/20 covers 173.245.48.0 – 173.245.63.255
      expect(isCloudflareIP('173.245.63.255')).toBe(true);
    });

    it('accepts a CF IPv6 in 2606:4700::/32', () => {
      expect(isCloudflareIP('2606:4700::1')).toBe(true);
    });

    it('accepts a CF IPv6 in the /29 range', () => {
      expect(isCloudflareIP('2a06:98c0::1')).toBe(true);
    });

    it('accepts an IPv4-mapped IPv6 form of a CF IP (dual-stack socket)', () => {
      expect(isCloudflareIP('::ffff:173.245.50.1')).toBe(true);
    });
  });

  describe('non-Cloudflare ranges (false)', () => {
    it('rejects a Hetzner-style IP', () => {
      expect(isCloudflareIP('116.202.5.10')).toBe(false);
    });

    it('rejects a Google DNS IP', () => {
      expect(isCloudflareIP('8.8.8.8')).toBe(false);
    });

    it('rejects an IPv4 just outside a CF range', () => {
      // 173.245.48.0/20 ends at 173.245.63.255; .64.0 is outside
      expect(isCloudflareIP('173.245.64.0')).toBe(false);
    });

    it('rejects IPv4 localhost', () => {
      expect(isCloudflareIP('127.0.0.1')).toBe(false);
    });

    it('rejects IPv6 localhost', () => {
      expect(isCloudflareIP('::1')).toBe(false);
    });

    it('rejects a non-CF IPv6 address', () => {
      expect(isCloudflareIP('2001:4860:4860::8888')).toBe(false);  // Google DNS v6
    });
  });

  describe('invalid input (false)', () => {
    it('returns false for null / undefined / empty', () => {
      expect(isCloudflareIP(null)).toBe(false);
      expect(isCloudflareIP(undefined)).toBe(false);
      expect(isCloudflareIP('')).toBe(false);
    });

    it('returns false for non-string input', () => {
      expect(isCloudflareIP(123)).toBe(false);
      expect(isCloudflareIP({})).toBe(false);
      expect(isCloudflareIP([])).toBe(false);
    });

    it('returns false for malformed strings', () => {
      expect(isCloudflareIP('not an ip')).toBe(false);
      expect(isCloudflareIP('999.999.999.999')).toBe(false);
      expect(isCloudflareIP('1.2.3')).toBe(false);
    });
  });
});
