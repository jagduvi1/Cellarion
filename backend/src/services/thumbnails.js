/**
 * Card-size thumbnails of processed bottle/wine photos.
 *
 * GET /api/uploads/thumbs/processed/<name>.<ext>.webp is the thumbnail of
 * /api/uploads/processed/<name>.<ext>. The first request renders it from the
 * source with sharp and writes it under /app/uploads/thumbs/processed/; every
 * later one is a plain file read. The source is never rewritten (random-UUID
 * filenames), so a thumbnail that exists is immutable and carries the same
 * long cache as the source; a miss is no-store, like every other uploads miss
 * (see middleware/uploadsStatic.js — a cached 404 once stuck at Cloudflare for
 * a year).
 *
 * Why: the processed photos are full-resolution PNGs (prod 2026-09: median
 * ~300 KB, some over 10 MB) and they are tall and narrow, while cards and list
 * rows show them 36–350 CSS px tall. A 400×640 WebP is ~13 KB on average —
 * about 40× less for every card grid, and small enough to keep a whole cellar's
 * photos on a phone for offline use (#1355).
 *
 * Unauthenticated like the rest of /api/uploads: it can only derive a thumbnail
 * from a file that is already publicly served there.
 */
const fs = require('fs');
const path = require('path');
const { IMMUTABLE_CACHE } = require('../middleware/uploadsStatic');

const THUMB_MAX_WIDTH = 400;
const THUMB_MAX_HEIGHT = 640; // photos are tall — bound by height, not a square box
const THUMB_QUALITY = 78;
const THUMBS_SUBDIR = 'thumbs';
const SOURCE_SUBDIR = 'processed';
// Source filenames are `<uuid>.<ext>` (imageProcessor / cellarImport).
const SOURCE_NAME = /^[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i;
const MAX_CONCURRENT = 2;  // sharp renders at once
const MAX_QUEUED = 40;     // waiting beyond that → 503; the client falls back to the full image

/** `/api/uploads/processed/x.png` → `/api/uploads/thumbs/processed/x.png.webp`; else null. */
function thumbUrlFor(url) {
  if (typeof url !== 'string') return null;
  const m = /^\/api\/uploads\/processed\/([^/]+)$/.exec(url);
  return m && SOURCE_NAME.test(m[1]) ? `/api/uploads/${THUMBS_SUBDIR}/${SOURCE_SUBDIR}/${m[1]}.webp` : null;
}

function createThumbnailService({ uploadsRoot = '/app/uploads', sharp: sharpImpl = null } = {}) {
  const getSharp = () => sharpImpl || require('sharp'); // lazy: only a render needs it
  const sourceDir = path.join(uploadsRoot, SOURCE_SUBDIR);
  const thumbDir = path.join(uploadsRoot, THUMBS_SUBDIR, SOURCE_SUBDIR);

  // One render per thumbnail at a time, and a small global limit on renders.
  const inFlight = new Map();
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((resolve, reject) => {
    if (active < MAX_CONCURRENT) { active++; resolve(); return; }
    if (waiting.length >= MAX_QUEUED) { reject(Object.assign(new Error('busy'), { code: 'BUSY' })); return; }
    waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };

  async function render(sourceName, thumbPath) {
    await acquire();
    try {
      const buf = await getSharp()(path.join(sourceDir, sourceName))
        .rotate()
        .resize({ width: THUMB_MAX_WIDTH, height: THUMB_MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY, alphaQuality: 80 })
        .toBuffer();
      await fs.promises.mkdir(thumbDir, { recursive: true });
      // Write-then-rename so a concurrent reader never sees half a file.
      const tmp = `${thumbPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, thumbPath);
    } finally {
      release();
    }
  }

  function ensureThumb(sourceName, thumbPath) {
    if (!inFlight.has(sourceName)) {
      inFlight.set(sourceName, render(sourceName, thumbPath).finally(() => inFlight.delete(sourceName)));
    }
    return inFlight.get(sourceName);
  }

  /** Express handler, mounted at /api/uploads/thumbs. */
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store'); // until a file is actually served
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'Method not allowed' });
    const m = /^\/processed\/([^/]+)\.webp$/.exec(req.path);
    if (!m || !SOURCE_NAME.test(m[1])) return res.status(404).json({ error: 'Not found' });
    const sourceName = m[1];
    const thumbPath = path.join(thumbDir, `${sourceName}.webp`);

    try {
      await fs.promises.access(thumbPath);
    } catch {
      try {
        await fs.promises.access(path.join(sourceDir, sourceName));
      } catch {
        return res.status(404).json({ error: 'Not found' });
      }
      try {
        await ensureThumb(sourceName, thumbPath);
      } catch (err) {
        if (err.code === 'BUSY') {
          res.setHeader('Retry-After', '5');
          return res.status(503).json({ error: 'Thumbnail busy' });
        }
        console.warn(`[thumbs] could not render ${sourceName}:`, err.message);
        return res.status(500).json({ error: 'Thumbnail failed' });
      }
    }

    res.setHeader('Cache-Control', IMMUTABLE_CACHE);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // cacheControl:false — send would otherwise replace ours with max-age=0.
    return res.sendFile(thumbPath, { cacheControl: false }, (err) => {
      if (err && !res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).json({ error: 'Not found' });
      }
    });
  }

  /** Delete the thumbnail of a source upload URL. Never throws. */
  async function unlinkThumbFor(url) {
    const thumb = thumbUrlFor(url);
    if (!thumb) return;
    try {
      await fs.promises.unlink(path.join(thumbDir, `${path.basename(url)}.webp`));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[thumbs] could not unlink thumbnail of ${url}:`, err.message);
    }
  }

  /**
   * Remove thumbnails whose source is gone — the safety net for any deletion
   * path that bypasses unlinkThumbFor. Returns the number removed.
   */
  async function sweepOrphanThumbs() {
    let names;
    try {
      names = await fs.promises.readdir(thumbDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const full = path.join(thumbDir, name);
      if (name.endsWith('.tmp')) {
        // A render that died mid-write; leave fresh ones to their writer.
        try {
          const st = await fs.promises.stat(full);
          if (Date.now() - st.mtimeMs > 60 * 60 * 1000) { await fs.promises.unlink(full); removed++; }
        } catch { /* gone */ }
        continue;
      }
      if (!name.endsWith('.webp')) continue;
      const sourceName = name.slice(0, -'.webp'.length);
      try {
        await fs.promises.access(path.join(sourceDir, sourceName));
      } catch {
        try { await fs.promises.unlink(full); removed++; } catch { /* gone */ }
      }
    }
    return removed;
  }

  return { handler, unlinkThumbFor, sweepOrphanThumbs };
}

const defaultService = createThumbnailService();

module.exports = {
  createThumbnailService,
  thumbUrlFor,
  thumbnailHandler: defaultService.handler,
  unlinkThumbFor: defaultService.unlinkThumbFor,
  sweepOrphanThumbs: defaultService.sweepOrphanThumbs,
  THUMB_MAX_WIDTH,
  THUMB_MAX_HEIGHT,
};
