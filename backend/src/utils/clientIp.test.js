const { getClientIp } = require('./clientIp');

describe('getClientIp', () => {
  it('returns CF-Connecting-IP when present', () => {
    const req = { headers: { 'cf-connecting-ip': '1.2.3.4' }, ip: '172.69.0.1' };
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('falls back to req.ip when CF-Connecting-IP is absent', () => {
    const req = { headers: {}, ip: '192.168.1.50' };
    expect(getClientIp(req)).toBe('192.168.1.50');
  });
});
