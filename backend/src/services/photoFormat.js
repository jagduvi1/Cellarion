/**
 * The two sizes Cellarion handles a bottle photo at (scaling audit 2026-09-25).
 *
 * - What rembg is sent: at most REMBG_MAX_EDGE on the long side. rembg holds
 *   several full-size copies of the frame while it works: a 24 MP phone photo
 *   peaked at ~1.35 GB of its 1.5 GB memory cap (the scaling audit saw one
 *   killed, so that photo was never processed); the same frame at 2048 px
 *   peaks at ~0.78 GB and is done ~2.7× sooner. The kept image has the same
 *   cap, so a bottle that fills most of the frame loses nothing; one that
 *   fills less of it is kept smaller than before (the cut-out is taken from
 *   the 2048 px frame).
 * - What Cellarion keeps and serves: WebP, at most KEPT_MAX_EDGE on the long
 *   side, transparency kept losslessly. rembg returns a lossless PNG (≈430 KB
 *   on average on prod, 2026-09). Real processed photos came out about 8×
 *   smaller as WebP q82, at a median PSNR of 42 dB against the PNG and with
 *   the alpha channel identical. 2048 rather than a smaller cap keeps the
 *   small print on a label readable when zoomed, and cost only ~3% more than
 *   1600.
 *
 * sharp is already a backend dependency (services/imageSanitizer).
 */
const sharp = require('sharp');
const { MAX_PIXELS } = require('./imageSanitizer');

const KEPT_MAX_EDGE = 2048;
const KEPT_QUALITY = 82;
const KEPT_EXTENSION = 'webp';
const REMBG_MAX_EDGE = 2048;

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };

/**
 * Encode the image Cellarion keeps: auto-rotated, fit inside KEPT_MAX_EDGE
 * (never enlarged), WebP with lossless alpha. Colour-managed to sRGB and
 * stripped of metadata by sharp's defaults. Throws on an undecodable input.
 */
async function encodeKeptPhoto(input) {
  return sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: KEPT_MAX_EDGE, height: KEPT_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: KEPT_QUALITY })
    .toBuffer();
}

/**
 * The frame to hand rembg: `{ buffer, type, filename }`. A frame that already
 * fits (and needs no rotation) goes as it is, so it loses nothing to a
 * re-encode. A larger one is scaled down first — as PNG when it has
 * transparency (rembg skips removal for a photo that is already cut out, so
 * the alpha must survive), else as a high-quality JPEG. Transient: nothing
 * keeps these bytes. Throws on an undecodable input.
 */
async function prepareRembgInput(input) {
  const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  const upright = !meta.orientation || meta.orientation === 1;
  if (MIME[meta.format] && longEdge <= REMBG_MAX_EDGE && upright) {
    return { buffer: input, type: MIME[meta.format], filename: `input.${EXT[meta.format]}` };
  }
  const pipeline = sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: REMBG_MAX_EDGE, height: REMBG_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  if (meta.hasAlpha) {
    return { buffer: await pipeline.png({ compressionLevel: 3 }).toBuffer(), type: 'image/png', filename: 'input.png' };
  }
  return { buffer: await pipeline.jpeg({ quality: 92 }).toBuffer(), type: 'image/jpeg', filename: 'input.jpg' };
}

module.exports = {
  encodeKeptPhoto,
  prepareRembgInput,
  KEPT_MAX_EDGE,
  KEPT_QUALITY,
  KEPT_EXTENSION,
  REMBG_MAX_EDGE,
};
