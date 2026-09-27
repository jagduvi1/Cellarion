/**
 * Card-size thumbnails of bottle/wine photos.
 *
 * GET /api/uploads/thumbs/<dir>/<name>.<ext>.webp is the thumbnail of
 * /api/uploads/<dir>/<name>.<ext>, for the two folders photos are served
 * from: `processed` (the cut-out photos) and `originals` (photos kept with
 * their background — keepBackground uploads, imported never-cropped photos —
 * and, until rembg has run, a fresh upload). The first request renders it
 * from the source with sharp and writes it under /app/uploads/thumbs/<dir>/;
 * every later one is a plain file read. The source is never rewritten
 * (random-UUID filenames), so a thumbnail that exists is immutable and carries
 * the same long cache as the source; a miss is no-store, like every other
 * uploads miss (see middleware/uploadsStatic.js — a cached 404 once stuck at
 * Cloudflare for a year).
 *
 * Why: the processed photos are up to 2048 px tall (services/photoFormat —
 * until 2026-09 full-resolution PNGs, median ~300 KB, some over 10 MB), while
 * cards and list rows show them 36–350 CSS px tall. A 400×640 WebP is ~13 KB
 * on average — a fraction of the full photo for every card grid, and small
 * enough to keep a whole cellar's photos on a phone for offline use (#1355).
 * A new photo's thumbnail is rendered when it is processed (warmThumbFor), so
 * only older photos pay the first-request render. Until 2026-09-27 only
 * `processed` had thumbnails, so every keep-background photo shipped full
 * size to every card (release audit, L).
 *
 * A photo converted to WebP (scripts/convert-photos-webp.js) keeps its old
 * thumbnail address working: `x.png.webp` is answered with the thumbnail of
 * `x.webp` once `x.png` is gone — offline copies and API answers from before
 * the conversion still ask for the old name.
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
const SOURCE_SUBDIRS = ['processed', 'originals'];
// Source filenames are `<uuid>.<ext>` (imageProcessor / imageOps / cellarImport).
const SOURCE_NAME = /^[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i;
const SOURCE_URL = /^\/api\/uploads\/(processed|originals)\/([^/]+)$/;
const MAX_CONCURRENT = 2;  // sharp renders at once
const MAX_QUEUED = 40;     // waiting beyond that → 503; the client falls back to the full image
// The sanitizer's decoded-pixel cap (services/imageSanitizer): a source that
// somehow exceeds it is refused rather than decoded into memory here.
const MAX_INPUT_PIXELS = 8000 * 8000;
// A source that failed to render is not tried again for a while: a broken
// file behind a busy card would otherwise cost a full decode attempt per view.
const FAILED_TTL_MS = 5 * 60 * 1000;

/** `/api/uploads/<dir>/<name>` → `{ dir, name }` when it can have a thumbnail; else null. */
function sourceOf(url) {
  if (typeof url !== 'string') return null;
  const m = SOURCE_URL.exec(url);
  return m && SOURCE_NAME.test(m[2]) ? { dir: m[1], name: m[2] } : null;
}

/** `/api/uploads/processed/x.png` → `/api/uploads/thumbs/processed/x.png.webp`; else null. */
function thumbUrlFor(url) {
  const src = sourceOf(url);
  return src ? `/api/uploads/${THUMBS_SUBDIR}/${src.dir}/${src.name}.webp` : null;
}

/** `x.png` / `x.jpg` → `x.webp`, the name a converted photo lives under; else null. */
function webpSibling(sourceName) {
  const m = /^([A-Za-z0-9_-]+)\.(?:png|jpe?g)$/i.exec(sourceName);
  return m ? `${m[1]}.webp` : null;
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

function createThumbnailService({ uploadsRoot = '/app/uploads', sharp: sharpImpl = null } = {}) {
  const getSharp = () => sharpImpl || require('sharp'); // lazy: only a render needs it
  const sourceDirOf = (dir) => path.join(uploadsRoot, dir);
  const thumbDirOf = (dir) => path.join(uploadsRoot, THUMBS_SUBDIR, dir);
  const thumbPathOf = (dir, sourceName) => path.join(thumbDirOf(dir), `${sourceName}.webp`);

  // One render per thumbnail at a time, and a small global limit on renders.
  const inFlight = new Map();
  const failedUntil = new Map(); // `${dir}/${name}` -> time until which it is not retried
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

  async function render(dir, sourceName) {
    await acquire();
    try {
      const buf = await getSharp()(path.join(sourceDirOf(dir), sourceName), { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: THUMB_MAX_WIDTH, height: THUMB_MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY, alphaQuality: 80 })
        .toBuffer();
      await fs.promises.mkdir(thumbDirOf(dir), { recursive: true });
      // Write-then-rename so a concurrent reader never sees half a file.
      const thumbPath = thumbPathOf(dir, sourceName);
      const tmp = `${thumbPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, thumbPath);
    } finally {
      release();
    }
  }

  function ensureThumb(dir, sourceName) {
    const key = `${dir}/${sourceName}`;
    const until = failedUntil.get(key);
    if (until && until > Date.now()) {
      return Promise.reject(Object.assign(new Error('failed recently'), { code: 'FAILED_RECENTLY' }));
    }
    if (!inFlight.has(key)) {
      inFlight.set(key, render(dir, sourceName)
        .catch((err) => {
          if (err.code !== 'BUSY') failedUntil.set(key, Date.now() + FAILED_TTL_MS);
          throw err;
        })
        .finally(() => inFlight.delete(key)));
    }
    return inFlight.get(key);
  }

  /** Express handler, mounted at /api/uploads/thumbs. */
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store'); // until a file is actually served
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'Method not allowed' });
    const m = /^\/(processed|originals)\/([^/]+)\.webp$/.exec(req.path);
    if (!m || !SOURCE_NAME.test(m[2])) return res.status(404).json({ error: 'Not found' });
    const dir = m[1];
    let sourceName = m[2];
    let thumbPath = thumbPathOf(dir, sourceName);

    if (!(await exists(thumbPath))) {
      if (!(await exists(path.join(sourceDirOf(dir), sourceName)))) {
        // Converted to WebP since this address was handed out: answer with
        // the thumbnail of the photo's new file.
        const sibling = webpSibling(sourceName);
        if (!sibling || !(await exists(path.join(sourceDirOf(dir), sibling)))) {
          return res.status(404).json({ error: 'Not found' });
        }
        sourceName = sibling;
        thumbPath = thumbPathOf(dir, sibling);
      }
      if (!(await exists(thumbPath))) {
        try {
          await ensureThumb(dir, sourceName);
        } catch (err) {
          if (err.code === 'BUSY') {
            res.setHeader('Retry-After', '5');
            return res.status(503).json({ error: 'Thumbnail busy' });
          }
          if (err.code !== 'FAILED_RECENTLY') console.warn(`[thumbs] could not render ${dir}/${sourceName}:`, err.message);
          return res.status(500).json({ error: 'Thumbnail failed' });
        }
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

  /**
   * Render the thumbnail of an upload URL now, if it isn't on disk yet —
   * called when a photo is processed, so its first card view is a plain file
   * read. Shares the render limit with requests. Never throws; returns
   * whether the thumbnail exists afterwards.
   */
  async function warmThumbFor(url) {
    try {
      const src = sourceOf(url);
      if (!src) return false;
      const thumbPath = thumbPathOf(src.dir, src.name);
      if (await exists(thumbPath)) return true;
      await ensureThumb(src.dir, src.name);
      return true;
    } catch (err) {
      if (err.code !== 'BUSY' && err.code !== 'FAILED_RECENTLY') {
        console.warn(`[thumbs] could not pre-render the thumbnail of ${url}:`, err.message);
      }
      return false;
    }
  }

  /** Delete the thumbnail of a source upload URL. Never throws. */
  async function unlinkThumbFor(url) {
    const src = sourceOf(url);
    if (!src) return;
    try {
      await fs.promises.unlink(thumbPathOf(src.dir, src.name));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[thumbs] could not unlink thumbnail of ${url}:`, err.message);
    }
  }

  /**
   * Remove thumbnails whose source is gone — the safety net for any deletion
   * path that bypasses unlinkThumbFor. Returns the number removed.
   */
  async function sweepOrphanThumbs() {
    let removed = 0;
    for (const dir of SOURCE_SUBDIRS) {
      let names;
      try {
        names = await fs.promises.readdir(thumbDirOf(dir));
      } catch {
        continue;
      }
      for (const name of names) {
        const full = path.join(thumbDirOf(dir), name);
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
          await fs.promises.access(path.join(sourceDirOf(dir), sourceName));
        } catch {
          try { await fs.promises.unlink(full); removed++; } catch { /* gone */ }
        }
      }
    }
    return removed;
  }

  return { handler, warmThumbFor, unlinkThumbFor, sweepOrphanThumbs };
}

const defaultService = createThumbnailService();

module.exports = {
  createThumbnailService,
  thumbUrlFor,
  thumbnailHandler: defaultService.handler,
  warmThumbFor: defaultService.warmThumbFor,
  unlinkThumbFor: defaultService.unlinkThumbFor,
  sweepOrphanThumbs: defaultService.sweepOrphanThumbs,
  THUMB_MAX_WIDTH,
  THUMB_MAX_HEIGHT,
  FAILED_TTL_MS,
};
