const { normalizeShopUrl, SHOP_URL_MAX_LENGTH } = require('./shopUrl');

describe('normalizeShopUrl', () => {
  test('keeps an http(s) address, normalised', () => {
    expect(normalizeShopUrl('https://shop.example/wine/123')).toEqual({ url: 'https://shop.example/wine/123' });
    expect(normalizeShopUrl('http://Shop.Example/Wine')).toEqual({ url: 'http://shop.example/Wine' });
    expect(normalizeShopUrl('  https://shop.example/a b  ')).toEqual({ url: 'https://shop.example/a%20b' });
  });

  test('adds https:// when the scheme was left off', () => {
    expect(normalizeShopUrl('shop.example/wine')).toEqual({ url: 'https://shop.example/wine' });
    expect(normalizeShopUrl('www.systembolaget.se/produkt/vin/123')).toEqual({ url: 'https://www.systembolaget.se/produkt/vin/123' });
  });

  test('a host with a port and no scheme is an address, not a scheme', () => {
    expect(normalizeShopUrl('shop.example:8080/wine')).toEqual({ url: 'https://shop.example:8080/wine' });
    expect(normalizeShopUrl('shop.example:8443')).toEqual({ url: 'https://shop.example:8443/' });
    // Still refused: a scheme that is not http(s), and a bare host with a port.
    expect(normalizeShopUrl('javascript:alert(1)')).toEqual({ error: true });
    expect(normalizeShopUrl('localhost:3000/x')).toEqual({ error: true });
  });

  test('an empty value means no link', () => {
    expect(normalizeShopUrl(undefined)).toEqual({ url: null });
    expect(normalizeShopUrl(null)).toEqual({ url: null });
    expect(normalizeShopUrl('   ')).toEqual({ url: null });
  });

  test('refuses anything that is not a web address', () => {
    expect(normalizeShopUrl('javascript:alert(1)')).toEqual({ error: true });
    expect(normalizeShopUrl('data:text/html,<script>alert(1)</script>')).toEqual({ error: true });
    expect(normalizeShopUrl('ftp://shop.example/wine')).toEqual({ error: true });
    expect(normalizeShopUrl('https://localhost/wine')).toEqual({ error: true });
    expect(normalizeShopUrl('not a link')).toEqual({ error: true });
    expect(normalizeShopUrl(42)).toEqual({ error: true });
    expect(normalizeShopUrl({ href: 'https://shop.example' })).toEqual({ error: true });
  });

  test('refuses a link longer than the cap', () => {
    const long = `https://shop.example/${'a'.repeat(SHOP_URL_MAX_LENGTH)}`;
    expect(normalizeShopUrl(long)).toEqual({ error: true });
  });
});
