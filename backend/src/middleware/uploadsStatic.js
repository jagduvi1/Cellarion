// Guard middleware for the public /api/uploads static mount: only image
// extensions are served.
//
// CACHING: the immutable long cache belongs to a file we ACTUALLY SERVED, so
// it is set by uploadsCacheHeaders below (passed to express.static's
// setHeaders), never by this guard. The guard used to set it for any
// image-looking path, including ones with no file behind them — the request
// then fell through to the 404 handler carrying a one-year immutable header,
// and Cloudflare cached the 404 for a year (confirmed 2026-09-15 on
// /api/uploads/blog/*.webp requested moments before the files landed:
// CF-Cache-Status HIT on a 404 that no purge was available for). The same trap
// would pin a bottle photo requested a moment before its processing finished.
// A miss is now explicitly uncacheable.
//
// NOTE: this mount is INTENTIONALLY unauthenticated. Bottle images must load
// from plain <img src> tags (which cannot send Authorization headers), and
// filenames are unguessable random UUIDs. Do not add requireAuth here without
// also changing how the frontend renders images.
const fs = require('fs');
const path = require('path');

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function uploadsGuard(req, res, next) {
  // Receipts kept during the receipt-scan beta (services/receiptArchive) share
  // the uploads volume but are private: never served, whatever the extension.
  // 404, not 403, so the folder's existence is not confirmed either.
  let decoded = req.path;
  try { decoded = decodeURIComponent(req.path); } catch { /* malformed: checked raw */ }
  if (/^\/+receipts(\/|$)/i.test(decoded)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const ext = path.extname(req.path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(403).json({ error: 'File type not allowed' });
  }
  // Uncacheable until a file is found: express.static replaces this on a hit
  // (uploadsCacheHeaders), and a miss keeps it, so no 404 is ever cached.
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * express.static setHeaders hook: a file that really exists is immutable
 * (filenames are content-addressed or random UUIDs and never rewritten).
 */
function uploadsCacheHeaders(res) {
  res.setHeader('Cache-Control', IMMUTABLE_CACHE);
}

// `/processed/x.png` or `/originals/x.jpg` — a kept photo's pre-WebP address.
const CONVERTED_PHOTO = /^\/(processed|originals)\/([A-Za-z0-9_-]+)\.(?:png|jpe?g)$/i;

/**
 * A photo converted to WebP (scripts/convert-photos-webp.js) keeps answering
 * at its old address, for good. Those addresses live on where Cellarion can't
 * rewrite them: other Cellarion servers that copied a registry wine over the
 * Bridge, Home Assistant, MCP clients, offline copies on phones, shared
 * links. Mounted AFTER express.static, so it runs only on a miss: `x.png`
 * that is gone is answered with `x.webp` from the same folder — the same
 * photo, never a different file — and anything else falls through to the
 * no-store 404.
 */
function createConvertedPhotoFallback({ uploadsRoot = '/app/uploads' } = {}) {
  return function convertedPhotoFallback(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = CONVERTED_PHOTO.exec(req.path);
    if (!m) return next();
    const webp = path.join(uploadsRoot, m[1], `${m[2]}.webp`);
    fs.promises.access(webp).then(() => {
      res.setHeader('Cache-Control', IMMUTABLE_CACHE);
      // cacheControl:false — send would otherwise replace ours with max-age=0.
      res.sendFile(webp, { cacheControl: false }, (err) => {
        if (err && !res.headersSent) {
          res.setHeader('Cache-Control', 'no-store');
          next();
        }
      });
    }, () => next());
  };
}

const convertedPhotoFallback = createConvertedPhotoFallback();

// A read of this public mount (a photo or its thumbnail) is not an API call
// and must not spend the per-IP API budget (app.js apiLimiter). One open cellar
// page loads dozens of thumbnails, and a Home Assistant install fetches every
// label photo from ONE address that also carries its polls, inventory reads
// and take-outs, so a large cellar could 429 the whole integration. Nothing
// here is expensive per request: a file read or a miss, and thumbnail renders
// are bounded on their own (services/thumbnails: 2 at once, a short queue,
// then 503, each thumbnail rendered once).
function isPublicUploadRead(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = req.originalUrl.split('?')[0];
  return p.startsWith('/api/uploads/');
}

module.exports = {
  isPublicUploadRead,
  uploadsGuard,
  uploadsCacheHeaders,
  createConvertedPhotoFallback,
  convertedPhotoFallback,
  ALLOWED_EXTENSIONS,
  IMMUTABLE_CACHE,
};
