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
 * the caching contract: only a file that was actually SERVED may carry the
 * immutable long cache. A 404 carrying it got cached by Cloudflare for a year
 * (2026-09-15), with no purge available.
 */

const { uploadsGuard, uploadsCacheHeaders, ALLOWED_EXTENSIONS, IMMUTABLE_CACHE } = require('../middleware/uploadsStatic');

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
  // The guard cannot know whether a file exists — express.static decides that
  // — so it must NOT pre-authorise a long cache. An image-looking path with no
  // file behind it falls through to the 404 handler, and that 404 inherits
  // whatever the guard set.
  test('an allowed path is no-store until a file is actually found', () => {
    const { headers } = run('/originals/bottle.png');
    expect(headers['Cache-Control']).toBe('no-store');
  });

  test('rejected files get no cache header', () => {
    const { headers } = run('/originals/bottle.exe');
    expect(headers['Cache-Control']).toBeUndefined();
  });

  test('a file that IS served becomes immutable — express.static setHeaders', () => {
    const headers = {};
    uploadsCacheHeaders({ setHeader: (k, v) => { headers[k] = v; } });
    expect(headers['Cache-Control']).toBe(IMMUTABLE_CACHE);
    expect(IMMUTABLE_CACHE).toBe('public, max-age=31536000, immutable');
  });

  test('the hit header replaces the miss header, so a served file is never no-store', () => {
    const { headers } = run('/processed/bottle.webp');
    expect(headers['Cache-Control']).toBe('no-store');
    uploadsCacheHeaders({ setHeader: (k, v) => { headers[k] = v; } });
    expect(headers['Cache-Control']).toBe(IMMUTABLE_CACHE);
  });
});

describe('allowlist contents', () => {
  test('is exactly the four raster image formats — adding a type here must be a conscious decision', () => {
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(['.jpeg', '.jpg', '.png', '.webp']);
  });
});

describe('convertedPhotoFallback — a converted photo keeps its old address', () => {
  // A real express stack in app.js order: guard → static → fallback → 404.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const http = require('http');
  const express = require('express');
  const rateLimit = require('express-rate-limit');
  const { createConvertedPhotoFallback } = require('../middleware/uploadsStatic');

  const STEM = '0f3b2a1c-1111-4222-8333-944445555666';
  const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 fake-bytes', 'latin1');
  let root;
  let server;
  let base;

  beforeAll(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uploads-'));
    await fs.promises.mkdir(path.join(root, 'processed'));
    await fs.promises.mkdir(path.join(root, 'originals'));
    await fs.promises.writeFile(path.join(root, 'processed', `${STEM}.webp`), WEBP);
    await fs.promises.writeFile(path.join(root, 'originals', `${STEM}.webp`), WEBP);
    await fs.promises.writeFile(path.join(root, 'processed', 'still-a.png'), 'PNG-BYTES');
    await fs.promises.writeFile(path.join(root, 'processed', 'still-a.webp'), WEBP);

    const app = express();
    // Like the real app (app.js mounts its API rate limiter ahead of
    // /api/uploads); generous enough never to trip in these tests.
    app.use(rateLimit({ windowMs: 60 * 1000, max: 10000, standardHeaders: false, legacyHeaders: false }));
    app.use('/api/uploads', uploadsGuard, express.static(root, { setHeaders: uploadsCacheHeaders }), createConvertedPhotoFallback({ uploadsRoot: root }));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}/api/uploads`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  test.each([
    `/processed/${STEM}.png`,
    `/processed/${STEM}.jpg`,
    `/processed/${STEM}.JPEG`,
    `/originals/${STEM}.png`,
  ])('%s is answered with the converted WebP, cached like any served file', async (p) => {
    const res = await fetch(`${base}${p}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(WEBP);
  });

  test('HEAD works the same way', async () => {
    const res = await fetch(`${base}/processed/${STEM}.png`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
  });

  test('a file that still exists under its own name is served as itself', async () => {
    const res = await fetch(`${base}/processed/still-a.png`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PNG-BYTES');
  });

  test('no converted file → the ordinary no-store 404 (never a cached miss)', async () => {
    const res = await fetch(`${base}/processed/aaaaaaaa-0000-4000-8000-000000000000.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test.each([
    `/thumbs/${STEM}.png`,               // only processed/ and originals/
    `/processed/${STEM}.gif`,            // not an allowed type at all
    '/processed/..%2Foriginals%2Fx.png', // never leaves its folder
  ])('%s is not rewritten', async (p) => {
    const res = await fetch(`${base}${p}`);
    expect(res.status).not.toBe(200);
  });
});
