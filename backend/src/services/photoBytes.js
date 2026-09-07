// One image reference → the bytes an MCP image content block carries.
//
// Two tools hand pixels to a model: the sommelier's get_pending_wine_images
// (label frames for curation) and get_photo (support ticket 2026-09-07: the
// connector returned photo URLs no MCP client can open — Claude's fetch
// refuses URLs that arrive in tool results, and the uploads sit behind the
// app anyway). Both must downscale the same way, so the rule lives here once:
// auto-rotate, fit inside MAX_EDGE, JPEG at a quality a label stays legible
// at. The caller decides WHICH reference it may show; this only renders it.
//
// sharp is already a backend dependency (services/imageSanitizer).
const { safeUploadPath } = require('./imageProcessor');

const IMAGE_MAX_EDGE = 1024;
const IMAGE_QUALITY = 82;
const UPLOAD_PREFIX = '/api/uploads/';
const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

/** Where the bytes of a stored reference come from, or null when nowhere we serve. */
function imageSource(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith(UPLOAD_PREFIX)) return { kind: 'upload', relative: ref.slice(UPLOAD_PREFIX.length) };
  if (DATA_URI.test(ref)) return { kind: 'inline' };
  if (/^https?:\/\//i.test(ref)) return { kind: 'external', url: ref };
  return null;
}

/**
 * Render a stored image reference (an /api/uploads/ path or an inline data:
 * image) as a downscaled JPEG. Returns { data (base64), mimeType, bytes } or
 * null when the reference is not something this server holds bytes for — an
 * external https URL, an empty field. Throws on an unreadable file or a
 * malformed image so the caller can answer `unavailable` honestly.
 */
async function renderImage(ref, { maxEdge = IMAGE_MAX_EDGE, quality = IMAGE_QUALITY } = {}) {
  const src = imageSource(ref);
  if (!src || src.kind === 'external') return null;
  let buf;
  if (src.kind === 'inline') {
    buf = Buffer.from(ref.match(DATA_URI)[2], 'base64');
  } else {
    // require('fs').promises rather than fs/promises: the image test suites
    // mock the 'fs' module, and the read has to go through that mock.
    buf = await require('fs').promises.readFile(safeUploadPath(src.relative));
  }
  const sharp = require('sharp');
  const out = await sharp(buf)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
  return { data: out.toString('base64'), mimeType: 'image/jpeg', bytes: out.length };
}

module.exports = { renderImage, imageSource, IMAGE_MAX_EDGE, IMAGE_QUALITY };
