/**
 * SSRF guard for server-side image download (attach_bottle_image image_url).
 *
 * WHY THIS TEST EXISTS: the backend can reach internal services (mongo, qdrant,
 * rembg) and the VM's cloud-metadata endpoint. A caller-supplied URL that
 * resolves — now or after a DNS rebind — to any of those must never be fetched.
 * The address classifier is the load-bearing gate; these pin every private /
 * reserved range and the scheme/port/redirect rules. The network path itself
 * (dns pinning, redirect re-validation) is exercised by the live e2e.
 */

const { isPrivateAddress, safeFetchImage } = require('./safeImageFetch');

describe('isPrivateAddress', () => {
  test.each([
    // IPv4 — every blocked range
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', // cloud metadata
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    // IPv6 — loopback, link-local, ULA, NAT64, v4-mapped-private
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '64:ff9b::7f00:1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    // not an IP at all
    'not-an-ip', '',
  ])('blocks %s', (addr) => {
    expect(isPrivateAddress(addr)).toBe(true);
  });

  test.each([
    '1.1.1.1', '8.8.8.8', '93.184.216.34', // public v4
    '172.15.0.1', '172.32.0.1', '11.0.0.1', // just OUTSIDE the private ranges
    '2606:4700:4700::1111', '2001:4860:4860::8888', // public v6
    '::ffff:8.8.8.8', // v4-mapped PUBLIC is allowed
  ])('allows %s', (addr) => {
    expect(isPrivateAddress(addr)).toBe(false);
  });
});

describe('safeFetchImage input validation (pre-network)', () => {
  test('rejects non-https schemes', async () => {
    await expect(safeFetchImage('http://example.com/x.jpg')).rejects.toThrow(/https/);
    await expect(safeFetchImage('ftp://example.com/x.jpg')).rejects.toThrow(/https/);
    await expect(safeFetchImage('file:///etc/passwd')).rejects.toThrow(/https/);
  });

  test('rejects a non-default port, embedded credentials, and garbage URLs', async () => {
    await expect(safeFetchImage('https://example.com:22/x.jpg')).rejects.toThrow(/default https port/);
    await expect(safeFetchImage('https://user:pass@example.com/x.jpg')).rejects.toThrow(/credentials/);
    await expect(safeFetchImage('not a url')).rejects.toThrow(/valid URL/);
  });

  test('rejects an https URL whose host is a literal private IP (no DNS needed)', async () => {
    await expect(safeFetchImage('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private or reserved/);
    await expect(safeFetchImage('https://127.0.0.1/x.jpg')).rejects.toThrow(/private or reserved/);
    await expect(safeFetchImage('https://[::1]/x.jpg')).rejects.toThrow(/private or reserved/);
  });
});
