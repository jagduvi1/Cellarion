const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Formats we re-encode. The DECODED format decides the output, not the file
// extension — the extension comes from the client-declared Content-Type and
// can lie (a PNG uploaded as image/jpeg must stay PNG, or a JPEG encode
// would flatten its alpha channel onto black).
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/**
 * Re-encode an image file in place, dropping all metadata.
 *
 * - EXIF (incl. GPS), XMP and IPTC are not copied to the output — sharp
 *   strips them unless .withMetadata() is requested.
 * - .rotate() bakes the EXIF orientation into the pixels first, so photos
 *   don't render sideways once the orientation tag is gone.
 * - The ICC colour profile is kept for RGB images (it describes the colour
 *   space, not the photographer). CMYK inputs are converted to sRGB instead —
 *   keeping a CMYK profile yields CMYK JPEGs that browsers render badly.
 * - Animated WebP keeps its animation ({ animated: true } decodes all frames
 *   and the webp encoder writes them back).
 * - The replace is ATOMIC: encode to a temp file in the same directory, then
 *   rename over the original. A crash mid-write can never corrupt the
 *   existing file, and concurrent readers (static serving, rembg, the
 *   backfill running against a live container) always see either the old or
 *   the new complete bytes.
 *
 * Throws if the file cannot be decoded (corrupt / not really an image), is
 * an unsupported format, or exceeds MAX_PIXELS — callers should respond 400
 * and delete the file.
 */
async function stripImageMetadata(filePath) {
  // Read into memory first — sharp can hold the input file handle open
  // (notably for WebP), which breaks the overwrite on Windows. Uploads are
  // capped at 10MB, so buffering is fine.
  const input = await fs.promises.readFile(filePath);

  const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  if (!SUPPORTED_FORMATS.has(meta.format)) {
    throw new Error(`Unsupported image format: ${meta.format || 'unknown'}`);
  }
  const format = meta.format;
  const animated = format === 'webp' && (meta.pages || 1) > 1;
  const isCmyk = meta.space === 'cmyk';

  let pipeline = sharp(input, { limitInputPixels: MAX_PIXELS, animated }).rotate();
  if (!isCmyk) {
    pipeline = pipeline.keepIccProfile();
  }

  let buffer;
  if (format === 'jpeg') {
    buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
  } else if (format === 'png') {
    buffer = await pipeline.png().toBuffer();
  } else {
    buffer = await pipeline.webp({ quality: 90 }).toBuffer();
  }

  // Atomic replace: temp file in the same directory + rename.
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
  );
  try {
    await fs.promises.writeFile(tmpPath, buffer);
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Buffer variant of stripImageMetadata for in-memory pipelines (e.g. the
 * base64 remove-bg preview, which never writes a file). Validates the input
 * decodes and is within MAX_PIXELS — fails CLOSED, throwing on oversized,
 * corrupt or unsupported input — then returns a re-encoded, metadata-stripped
 * buffer. Throwing callers should respond 400.
 */
async function sanitizeImageBuffer(input) {
  const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  if (!SUPPORTED_FORMATS.has(meta.format)) {
    throw new Error(`Unsupported image format: ${meta.format || 'unknown'}`);
  }
  const format = meta.format;
  const animated = format === 'webp' && (meta.pages || 1) > 1;
  const isCmyk = meta.space === 'cmyk';

  let pipeline = sharp(input, { limitInputPixels: MAX_PIXELS, animated }).rotate();
  if (!isCmyk) pipeline = pipeline.keepIccProfile();

  if (format === 'jpeg') return pipeline.jpeg({ quality: 90 }).toBuffer();
  if (format === 'png') return pipeline.png().toBuffer();
  return pipeline.webp({ quality: 90 }).toBuffer();
}

/**
 * True when the file carries metadata worth stripping. Used by the backfill
 * script to skip already-clean files — re-encoding is lossy for JPEG, so a
 * re-run must not put clean files through another generation.
 */
async function hasStrippableMetadata(filePath) {
  const input = await fs.promises.readFile(filePath);
  const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  return !!(meta.exif || meta.xmp || meta.iptc || (meta.orientation && meta.orientation !== 1));
}

module.exports = { stripImageMetadata, sanitizeImageBuffer, hasStrippableMetadata, MAX_PIXELS };
