/**
 * Tests for the /api/uploads static-serving guard (middleware/uploadsStatic.js).
 *
 * WHY THIS TEST EXISTS:
 * /api/uploads is INTENTIONALLY unauthenticated — bottle images are rendered
 * with plain <img src> tags, which cannot send Authorization headers. The
 * security model is unguessable random-UUID filenames plus a strict image
 * extension allowlist so the mount can never serve non-image files (e.g. a
 * smuggled .html or .svg that could execute script, or server config files).
 * This suite pins the real exported guard used by app.js — the allowlist and
 * the immutable-cache header.
 */

const { uploadsGuard, ALLOWED_EXTENSIONS } = require('../middleware/uploadsStatic');

function run(reqPath) {
  const req = { path: reqPath };
  const headers = {};
  let statusCode = null;
  let jsonBody = null;
  let nextCalled = false;
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
  };
  uploadsGuard(req, res, () => { nextCalled = true; });
  return { statusCode, jsonBody, headers, nextCalled };
}

describe('uploadsGuard extension allowlist', () => {
  test.each(['.jpg', '.jpeg', '.png', '.webp'])(
    'allows %s files through to static serving',
    (ext) => {
      const { nextCalled, statusCode } = run(`/originals/0f3b2a1c-uuid${ext}`);
      expect(nextCalled).toBe(true);
      expect(statusCode).toBeNull();
    }
  );

  test('extension matching is case-insensitive (.JPG allowed)', () => {
    const { nextCalled } = run('/originals/photo.JPG');
    expect(nextCalled).toBe(true);
  });

  test.each(['.exe', '.html', '.svg', '.js', '.php', '.env'])(
    'rejects %s with 403 and does not fall through to static',
    (ext) => {
      const { statusCode, jsonBody, nextCalled } = run(`/originals/file${ext}`);
      expect(statusCode).toBe(403);
      expect(jsonBody).toEqual({ error: 'File type not allowed' });
      expect(nextCalled).toBe(false);
    }
  );

  test('rejects extensionless paths (directory probing) with 403', () => {
    const { statusCode, nextCalled } = run('/originals/');
    expect(statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  test('only the final extension counts — file.jpg.exe is rejected', () => {
    const { statusCode, nextCalled } = run('/originals/file.jpg.exe');
    expect(statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });
});

describe('uploadsGuard caching', () => {
  test('allowed files get an immutable long-cache header', () => {
    const { headers } = run('/originals/bottle.png');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  test('rejected files get no cache header', () => {
    const { headers } = run('/originals/bottle.exe');
    expect(headers['Cache-Control']).toBeUndefined();
  });
});

describe('allowlist contents', () => {
  test('is exactly the four raster image formats — adding a type here must be a conscious decision', () => {
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(['.jpeg', '.jpg', '.png', '.webp']);
  });
});
