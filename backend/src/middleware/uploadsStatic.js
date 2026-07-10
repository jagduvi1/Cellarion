// Guard middleware for the public /api/uploads static mount: only image
// extensions are served, and responses cache forever (uploads are immutable).
//
// NOTE: this mount is INTENTIONALLY unauthenticated. Bottle images must load
// from plain <img src> tags (which cannot send Authorization headers), and
// filenames are unguessable random UUIDs. Do not add requireAuth here without
// also changing how the frontend renders images.
const path = require('path');

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function uploadsGuard(req, res, next) {
  const ext = path.extname(req.path).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(403).json({ error: 'File type not allowed' });
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
}

module.exports = { uploadsGuard, ALLOWED_EXTENSIONS };
