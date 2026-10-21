/**
 * thumbPath — the thumbnail path the inventory hands an integration.
 *
 * WHY THIS TEST EXISTS:
 * The Home Assistant client fetches exactly the paths this returns, from the
 * instance itself, without credentials. Anything that is not a photo on this
 * instance (an external link, an inline data: image, another host's upload)
 * must come back null, never as a path that points somewhere else; and a
 * photo here must map to the same thumbnail the web app's thumbUrl uses.
 */
const { thumbPath, ownHosts } = require('./thumbPath');

const HOSTS = new Set(['cellarion.app']);
const t = (url) => thumbPath(url, { hosts: HOSTS });

describe('thumbPath', () => {
  test.each([
    ['/api/uploads/processed/abc-123.webp', '/api/uploads/thumbs/processed/abc-123.webp.webp'],
    ['/api/uploads/processed/abc_123.png', '/api/uploads/thumbs/processed/abc_123.png.webp'],
    ['/api/uploads/originals/abc.jpg', '/api/uploads/thumbs/originals/abc.jpg.webp'],
    ['/api/uploads/originals/abc.jpeg', '/api/uploads/thumbs/originals/abc.jpeg.webp'],
    // A bare upload filename is relative to /api/uploads (photoState.absoluteImageUrl).
    ['processed/abc.webp', '/api/uploads/thumbs/processed/abc.webp.webp'],
    // An absolute URL on this instance.
    ['https://cellarion.app/api/uploads/processed/abc.webp', '/api/uploads/thumbs/processed/abc.webp.webp'],
    ['HTTPS://CELLARION.APP/api/uploads/processed/abc.webp', '/api/uploads/thumbs/processed/abc.webp.webp'],
  ])('%s → %s', (input, expected) => {
    expect(t(input)).toBe(expected);
  });

  test.each([
    [null], [undefined], [''], [42], [{}],
    ['data:image/png;base64,AAAA'],
    // External links and other hosts: their thumbnail is not here.
    ['https://example.com/label.jpg'],
    ['https://other.example/api/uploads/processed/abc.webp'],
    ['//cellarion.app/api/uploads/processed/abc.webp'],
    // Not a photo folder, not a photo extension, already a thumbnail.
    ['/api/uploads/avatars/abc.webp'],
    ['/api/uploads/processed/abc.gif'],
    ['/api/uploads/thumbs/processed/abc.webp.webp'],
    ['/api/uploads/processed/sub/abc.webp'],
    ['/api/uploads/processed/../abc.webp'],
    ['/api/uploads/processed/abc.webp?v=2'],
    ['https://cellarion.app/api/uploads/processed/abc.webp?v=2'],
    // Case: the client accepts lowercase folders and extensions only.
    ['/api/uploads/Processed/abc.webp'],
    ['/api/uploads/processed/abc.PNG'],
    ['abc.webp'],
    ['javascript:alert(1)'],
  ])('%p → null', (input) => {
    expect(t(input)).toBeNull();
  });

  test('every path it returns matches the integration client\'s IMAGE_PATH_RE', () => {
    const IMAGE_PATH_RE = /^\/api\/uploads\/thumbs\/(processed|originals)\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)\.webp$/;
    for (const p of ['/api/uploads/processed/a.webp', '/api/uploads/originals/b-c_d.jpg', 'processed/e.png']) {
      expect(t(p)).toMatch(IMAGE_PATH_RE);
    }
  });
});

describe('ownHosts', () => {
  test('BACKEND_URL and FRONTEND_URL hosts, ports kept', () => {
    expect([...ownHosts({ BACKEND_URL: 'https://api.example.org/', FRONTEND_URL: 'http://localhost:8080' })])
      .toEqual(['api.example.org', 'localhost:8080']);
  });

  test('neither set → the default instance, like photoState', () => {
    expect([...ownHosts({})]).toEqual(['cellarion.app']);
  });

  test('a value that is not a URL is ignored', () => {
    expect([...ownHosts({ FRONTEND_URL: 'not a url', BACKEND_URL: 'https://x.example' })]).toEqual(['x.example']);
  });
});
