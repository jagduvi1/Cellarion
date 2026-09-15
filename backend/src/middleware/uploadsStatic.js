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
const path = require('path');

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function uploadsGuard(req, res, next) {
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

module.exports = { uploadsGuard, uploadsCacheHeaders, ALLOWED_EXTENSIONS, IMMUTABLE_CACHE };
