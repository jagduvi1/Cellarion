const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * Strips privacy-sensitive metadata from uploaded images by re-encoding
 * them in place.
 *
 * Phone photos embed EXIF metadata — most critically GPS coordinates of
 * where the picture was taken (i.e. where the owner stores their wine).
 * Uploaded originals are served under /api/uploads and shown to other
 * users (shared cellars, public wine pages), so the file must be clean
 * before it is reachable. The background-removed PNG is already clean
 * (rembg re-encodes via PIL), but the original was stored byte-for-byte.
 */

// Hard ceiling on decoded pixels, aligned with MAX_IMAGE_DIMENSION (8000)
// in routes/images.js. The route's header-based dimension check fails open
// for formats it can't parse (e.g. extended VP8X WebP); this decode-time
// limit fails closed.
const MAX_PIXELS = 8000 * 8000;

const FORMAT_BY_EXT = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
};

/**
 * Re-encode an image file in place, dropping all metadata.
 *
 * - EXIF (incl. GPS), XMP and IPTC are not copied to the output — sharp
 *   strips them unless .withMetadata() is requested.
 * - .rotate() bakes the EXIF orientation into the pixels first, so photos
 *   don't render sideways once the orientation tag is gone.
 * - The ICC colour profile is kept: it describes the colour space, not the
 *   photographer, and dropping it would shift colours on wide-gamut photos.
 *
 * Throws if the file cannot be decoded (corrupt or not really an image) or
 * exceeds MAX_PIXELS — callers should respond 400 and delete the file.
 */
async function stripImageMetadata(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const format = FORMAT_BY_EXT[ext];
  if (!format) {
    throw new Error(`Unsupported image extension: ${ext}`);
  }

  // Read into memory first — sharp can hold the input file handle open
  // (notably for WebP), which breaks the in-place overwrite on Windows.
  // Uploads are capped at 10MB, so buffering is fine.
  const input = await fs.promises.readFile(filePath);
  const pipeline = sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .keepIccProfile();

  let buffer;
  if (format === 'jpeg') {
    buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
  } else if (format === 'png') {
    buffer = await pipeline.png().toBuffer();
  } else {
    buffer = await pipeline.webp({ quality: 90 }).toBuffer();
  }

  await fs.promises.writeFile(filePath, buffer);
}

module.exports = { stripImageMetadata, MAX_PIXELS };
