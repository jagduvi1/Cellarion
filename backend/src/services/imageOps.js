/**
 * Bottle-image ingestion — ONE implementation for both surfaces (the REST
 * upload route in routes/images.js and the MCP attach_bottle_image tool), so
 * validation, sanitisation, per-bottle caps, persistence and the background-
 * removal hand-off can never drift (same rule as bottleOps/rackOps/journalOps).
 *
 * The pipeline takes a BUFFER (REST reads multer's temp file into one; MCP
 * decodes base64 or a guarded URL download): sanitizeImageBuffer validates it
 * decodes, is a supported format (jpeg/png/webp), is within the pixel bomb
 * cap, and re-encodes with metadata (EXIF/GPS) stripped — fail closed. The
 * CLEAN bytes are what get persisted under a fresh random name; caller input
 * never lands on disk verbatim.
 *
 * Access is the CALLER's job (house style): `bottle`, when given, must already
 * be access-checked to editor+.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const BottleImage = require('../models/BottleImage');
const { ORIGINALS_DIR } = require('../config/upload');
const { sanitizeImageBuffer, detectImageFormat } = require('./imageSanitizer');
const { processImage, hashImageBytes } = require('./imageProcessor');
const { stripHtml } = require('../utils/sanitize');

const MAX_IMAGES_PER_BOTTLE = 20;
const EXT_FOR = { jpeg: 'jpg', png: 'png', webp: 'webp' };

/**
 * Image credits (attribution on wine-library photos) are ADMIN-only, on every
 * surface. The gate lives HERE — in the shared pipeline, not in each caller —
 * so REST and MCP cannot drift: a non-admin's credit is silently dropped, an
 * admin's is HTML-stripped and capped, exactly like the web upload always did.
 */
function sanitizeCredit(credit, userRoles) {
  const isAdmin = Array.isArray(userRoles) && userRoles.includes('admin');
  if (!isAdmin || !credit || typeof credit !== 'string') return null;
  return stripHtml(credit).trim().slice(0, 200) || null;
}

/**
 * Validate, sanitise and persist one image buffer for a bottle (and/or a
 * registry wine), create its BottleImage row and kick off background removal.
 *
 * @param {object} opts
 * @param {Buffer}  opts.buffer            raw image bytes (≤ the caller's cap)
 * @param {string}  opts.userId            uploader
 * @param {string[]} [opts.userRoles]      uploader's roles — credit only sticks for admins
 * @param {object}  [opts.bottle]          access-checked bottle doc (editor+)
 * @param {string}  [opts.wineDefinitionId] pre-validated registry wine id
 * @param {string}  [opts.credit]          RAW credit — gated + sanitised here (admin-only)
 * @param {object}  req                    for downstream audit attribution
 * @returns {{ image }} | {{ error: { status, message } }}
 */
async function ingestBottleImage({ buffer, userId, userRoles = [], bottle = null, wineDefinitionId = null, credit = null }, req) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { error: { status: 400, message: 'No image data provided' } };
  }

  if (bottle) {
    const imageCount = await BottleImage.countDocuments({ bottle: bottle._id });
    if (imageCount >= MAX_IMAGES_PER_BOTTLE) {
      return { error: { status: 400, message: `Maximum of ${MAX_IMAGES_PER_BOTTLE} images per bottle reached` } };
    }
  }

  // Decode + validate + strip metadata in one fail-closed step. The returned
  // buffer preserves the DECODED format, so sniff that (never a client claim)
  // for the stored extension.
  let clean;
  try {
    clean = await sanitizeImageBuffer(buffer);
  } catch (err) {
    return { error: { status: 400, message: 'Image could not be processed — it must be a JPEG, PNG or WebP within normal dimensions' } };
  }
  const format = detectImageFormat(clean);
  if (!format) {
    return { error: { status: 400, message: 'Image format could not be verified' } };
  }

  const filename = `${crypto.randomUUID()}.${EXT_FOR[format]}`;
  // Join against the fixed uploads dir with a server-generated basename — no
  // caller-controlled path segment exists. A disk failure (EACCES, ENOSPC) is
  // an INFRA fault, not the caller's — surface a clean 500 rather than letting
  // it throw out of the tool as a non-JSON crash.
  try {
    await fs.promises.writeFile(path.join(ORIGINALS_DIR, filename), clean);
  } catch (err) {
    console.error('[imageOps] failed to persist image:', err.message);
    return { error: { status: 500, message: 'Could not save the image right now — please try again later' } };
  }

  // Content hash of the stored bytes (export/re-import dedup). Best-effort —
  // a hash failure must never block the upload.
  let contentHash = null;
  try { contentHash = hashImageBytes(clean); } catch { /* non-fatal */ }

  const image = new BottleImage({
    bottle: bottle ? bottle._id : null,
    wineDefinition: wineDefinitionId || null,
    uploadedBy: userId,
    originalUrl: `/api/uploads/originals/${filename}`,
    status: 'uploaded',
    credit: sanitizeCredit(credit, userRoles),
    contentHash,
  });
  await image.save();

  // Fire-and-forget background removal (rembg) — same hand-off as the route.
  processImage(image._id).catch((err) => console.error('Background processing error:', err.message));

  return { image };
}

/**
 * Admin surface: ingest an image and make it the wine's OFFICIAL photo in one
 * step — pre-approved (public), replacing any prior official image, with the
 * credit stored on both the image and the wine. ONE implementation for the
 * admin REST route and the admin MCP tool, mirroring what
 * routes/admin/images.js approve does for user uploads (minus original-file
 * deletion — background removal still needs the source; imageProcessor's
 * post-process hook upgrades wine.image to the clean version when it's ready).
 *
 * Caller must have verified the wine exists and the actor is an admin
 * (userRoles is still forwarded so the shared credit gate applies uniformly).
 */
async function attachOfficialWineImage({ buffer, wineDefinitionId, credit = null, userId, userRoles = [] }, req) {
  const ingest = await ingestBottleImage({ buffer, userId, userRoles, wineDefinitionId, credit }, req);
  if (ingest.error) return ingest;
  const image = ingest.image;

  await BottleImage.updateMany(
    { wineDefinition: wineDefinitionId, assignedToWine: true },
    { assignedToWine: false }
  );
  image.status = 'approved';
  image.visibility = 'public';
  image.reviewedBy = userId;
  image.reviewedAt = new Date();
  image.assignedToWine = true;
  await image.save();

  const WineDefinition = require('../models/WineDefinition');
  await WineDefinition.findByIdAndUpdate(wineDefinitionId, {
    image: image.processedUrl || image.originalUrl,
    // The GATED credit from the shared pipeline — never the raw caller input.
    imageCredit: image.credit,
  });
  require('./search').indexWine(wineDefinitionId);

  return { image };
}

/**
 * Persist the ORIGINAL frame a label scan was run on, so a curator working the
 * pending-identity queue can read the label instead of guessing from three
 * broken strings. Until now the scan bytes lived only in the request handler
 * and were garbage-collected with it — which is exactly why an unreadable
 * label produced an unfixable registry row.
 *
 * Deliberately NOT ingestBottleImage: no per-bottle cap applies (there is no
 * bottle), no background removal is kicked off (the scan flow already ran one
 * on a copy, and a curator wants the untouched frame), and the row is born
 * private + kind:'label-scan' so it can never reach a gallery or a wine image.
 *
 * The buffer must ALREADY be sanitised (the scan route's sanitizeImageBuffer
 * output — decoded, pixel-capped, EXIF/GPS stripped): this function persists
 * what it is given, so passing raw client bytes here would be a bug.
 *
 * Best-effort by contract: a failure returns null and the caller carries on —
 * losing the scan copy must never fail the user's scan.
 *
 * @returns {Promise<object|null>} the BottleImage doc, or null
 */
async function persistLabelScan({ buffer, userId }) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const format = detectImageFormat(buffer);
    if (!format) return null;
    const filename = `${crypto.randomUUID()}.${EXT_FOR[format]}`;
    await fs.promises.writeFile(path.join(ORIGINALS_DIR, filename), buffer);
    let contentHash = null;
    try { contentHash = hashImageBytes(buffer); } catch { /* non-fatal */ }
    const image = new BottleImage({
      bottle: null,
      wineDefinition: null,     // set at commit, by services/wineCommit
      uploadedBy: userId,
      originalUrl: `/api/uploads/originals/${filename}`,
      status: 'uploaded',
      visibility: 'private',
      kind: 'label-scan',
      contentHash,
    });
    await image.save();
    return image;
  } catch (err) {
    console.warn('[imageOps] label-scan persist failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = { ingestBottleImage, attachOfficialWineImage, persistLabelScan, MAX_IMAGES_PER_BOTTLE };
