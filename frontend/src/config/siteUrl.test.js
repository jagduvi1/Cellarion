import SITE_URL, { resolveSiteUrl } from './siteUrl';

describe('resolveSiteUrl', () => {
  test('a self-hosted install names its own address, not the hosted site', () => {
    expect(resolveSiteUrl('', { origin: 'http://192.168.1.100:30579' })).toBe('http://192.168.1.100:30579');
  });

  test('the hosted site names cellarion.app', () => {
    expect(resolveSiteUrl(undefined, { origin: 'https://cellarion.app' })).toBe('https://cellarion.app');
  });

  test('an address pinned at build time wins over the browser', () => {
    expect(resolveSiteUrl('https://wine.example.com/', { origin: 'http://10.0.0.5:8080' })).toBe('https://wine.example.com');
  });

  test('without a usable browser address it falls back to the hosted site', () => {
    expect(resolveSiteUrl('', undefined)).toBe('https://cellarion.app');
    expect(resolveSiteUrl('', { origin: 'null' })).toBe('https://cellarion.app');
  });
});

test('the address the pages import is the one in the browser', () => {
  expect(SITE_URL).toBe(window.location.origin);
});
