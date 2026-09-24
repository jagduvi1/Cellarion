/**
 * Tests for services/thumbnails.js — card-size WebP thumbnails rendered on
 * first request under /api/uploads/thumbs. Uses real sharp on a temp dir.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createThumbnailService, thumbUrlFor, THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT } = require('./thumbnails');
const { IMMUTABLE_CACHE } = require('../middleware/uploadsStatic');

const SOURCE = '0f3b2a1c-1111-4222-8333-944445555666.png';

let root;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thumbs-'));
  await fs.promises.mkdir(path.join(root, 'processed'), { recursive: true });
  // A tall bottle-shaped photo with transparency, like a rembg output.
  await sharp({ create: { width: 330, height: 1280, channels: 4, background: { r: 120, g: 20, b: 40, alpha: 0.9 } } })
    .png()
    .toFile(path.join(root, 'processed', SOURCE));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

function call(handler, reqPath, method = 'GET') {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      headersSent: false,
      setHeader: (k, v) => { headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers }); return this; },
      sendFile(file, opts, cb) { resolve({ status: 200, file, opts, headers }); if (cb) cb(); },
    };
    handler({ path: reqPath, method }, res);
  });
}

describe('thumbUrlFor', () => {
  test('maps a processed upload to its thumbnail URL', () => {
    expect(thumbUrlFor(`/api/uploads/processed/${SOURCE}`)).toBe(`/api/uploads/thumbs/processed/${SOURCE}.webp`);
  });
  test.each([
    null,
    'https://example.com/x.png',
    `/api/uploads/originals/${SOURCE}`,
    '/api/uploads/processed/../secret.png',
    '/api/uploads/processed/x.svg',
  ])('returns null for %s', (url) => {
    expect(thumbUrlFor(url)).toBeNull();
  });
});

describe('thumbnail handler', () => {
  test('renders a height-bounded WebP on first request, then serves it from disk', async () => {
    const { handler } = createThumbnailService({ uploadsRoot: root });
    const first = await call(handler, `/processed/${SOURCE}.webp`);
    expect(first.status).toBe(200);
    expect(first.file).toBe(path.join(root, 'thumbs', 'processed', `${SOURCE}.webp`));
    expect(first.headers['Cache-Control']).toBe(IMMUTABLE_CACHE);
    expect(first.headers['Content-Type']).toBe('image/webp');
    expect(first.opts.cacheControl).toBe(false);

    const meta = await sharp(first.file).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.height).toBe(THUMB_MAX_HEIGHT);
    expect(meta.width).toBeLessThanOrEqual(THUMB_MAX_WIDTH);
    expect(meta.width).toBeGreaterThan(100); // not a sliver
    expect(meta.hasAlpha).toBe(true);

    const mtime = (await fs.promises.stat(first.file)).mtimeMs;
    const second = await call(handler, `/processed/${SOURCE}.webp`);
    expect(second.status).toBe(200);
    expect((await fs.promises.stat(second.file)).mtimeMs).toBe(mtime);
  });

  test('a missing source is a no-store 404 and writes nothing', async () => {
    const { handler } = createThumbnailService({ uploadsRoot: root });
    const r = await call(handler, '/processed/aaaaaaaa-0000-4000-8000-000000000000.png.webp');
    expect(r.status).toBe(404);
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(fs.existsSync(path.join(root, 'thumbs'))).toBe(false);
  });

  test.each([
    `/processed/${SOURCE}`,                 // no .webp suffix
    `/originals/${SOURCE}.webp`,            // only processed/ has thumbnails
    '/processed/..%2F..%2Fetc%2Fpasswd.png.webp',
    '/processed/../processed/x.png.webp',
    '/processed/evil.svg.webp',
  ])('rejects %s', async (p) => {
    const { handler } = createThumbnailService({ uploadsRoot: root });
    const r = await call(handler, p);
    expect(r.status).toBe(404);
    expect(r.headers['Cache-Control']).toBe('no-store');
  });

  test('only GET and HEAD', async () => {
    const { handler } = createThumbnailService({ uploadsRoot: root });
    expect((await call(handler, `/processed/${SOURCE}.webp`, 'DELETE')).status).toBe(405);
  });

  test('renders each thumbnail once under concurrent requests, and answers 503 when the queue is full', async () => {
    const release = [];
    let renders = 0;
    const fakeSharp = () => {
      renders++;
      const chain = {
        rotate: () => chain,
        resize: () => chain,
        webp: () => chain,
        toBuffer: () => new Promise((resolve) => release.push(() => resolve(Buffer.from('webp')))),
      };
      return chain;
    };
    const { handler } = createThumbnailService({ uploadsRoot: root, sharp: fakeSharp });

    // Same source twice → one render.
    const a = call(handler, `/processed/${SOURCE}.webp`);
    const b = call(handler, `/processed/${SOURCE}.webp`);
    await new Promise((r) => setTimeout(r, 20));
    expect(renders).toBe(1);

    // Fill the render slots and the queue with distinct sources.
    const names = [];
    for (let i = 0; i < 45; i++) {
      const n = `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}.png`;
      names.push(n);
      await fs.promises.writeFile(path.join(root, 'processed', n), 'x');
    }
    const pending = names.map((n) => call(handler, `/processed/${n}.webp`));
    const busy = await Promise.race([
      Promise.all(pending).then(() => null),
      new Promise((r) => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(busy).toBe('timeout'); // most are still waiting…
    // …but the overflow already got its answer.
    const settled = await Promise.all(pending.map((p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 10))])));
    const rejected = settled.filter((r) => r && r.status === 503);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0].headers['Retry-After']).toBe('5');

    // Drain every queued render so nothing writes after the temp dir is gone.
    let done = false;
    const all = Promise.all([a, b, ...pending]).then((r) => { done = true; return r; });
    while (!done) {
      if (release.length) release.shift()();
      await new Promise((r) => setTimeout(r, 2));
    }
    const results = await all;
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(renders).toBe(1 + 45 - rejected.length);
  });
});

describe('unlinkThumbFor / sweepOrphanThumbs', () => {
  test('unlinkThumbFor removes the thumbnail and tolerates a missing one', async () => {
    const { handler, unlinkThumbFor } = createThumbnailService({ uploadsRoot: root });
    const r = await call(handler, `/processed/${SOURCE}.webp`);
    expect(fs.existsSync(r.file)).toBe(true);
    await unlinkThumbFor(`/api/uploads/processed/${SOURCE}`);
    expect(fs.existsSync(r.file)).toBe(false);
    await expect(unlinkThumbFor(`/api/uploads/processed/${SOURCE}`)).resolves.toBeUndefined();
    await expect(unlinkThumbFor('https://example.com/x.png')).resolves.toBeUndefined();
  });

  test('sweep removes thumbnails whose source is gone and keeps the rest', async () => {
    const { handler, sweepOrphanThumbs } = createThumbnailService({ uploadsRoot: root });
    const kept = await call(handler, `/processed/${SOURCE}.webp`);
    const orphan = path.join(root, 'thumbs', 'processed', 'cccccccc-0000-4000-8000-000000000000.png.webp');
    await fs.promises.writeFile(orphan, 'x');
    expect(await sweepOrphanThumbs()).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(kept.file)).toBe(true);
  });

  test('sweep is a no-op before any thumbnail exists', async () => {
    const { sweepOrphanThumbs } = createThumbnailService({ uploadsRoot: root });
    expect(await sweepOrphanThumbs()).toBe(0);
  });
});
