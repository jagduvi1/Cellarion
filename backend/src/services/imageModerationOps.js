/**
 * Moderating a bottle photo — ONE implementation shared by the admin image
 * queue (routes/admin/images.js) and the sommelier's MCP tools
 * (mcp/tools/sommImages.js), so the two surfaces cannot drift on what is
 * published, what becomes a wine's picture, what the uploader is told, or what
 * gets audited (same rule as wineReportOps / pendingWineOps).
 *
 * Every function returns { ok: true, image, ... } or
 * { ok: false, code, message } with code 'not_found' | 'invalid_input' |
 * 'conflict'. The messages are the ones the admin page has always shown.
 *
 * Audit action strings are the admin route's own (admin.image.*) on both
 * surfaces; an MCP call adds `via: 'mcp'` to the detail, a web call adds
 * nothing, so the web's rows look exactly as they always have.
 */
const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { unlinkImageFiles, discardOriginal, processImage } = require('./imageProcessor');
const { logAudit } = require('./audit');
const { createNotification } = require('./notifications');
const { incrementCred } = require('../utils/cellarCred');
const { isValidId } = require('../utils/validation');
const { stripHtml } = require('../utils/sanitize');

// services/search pulls in the ESM-only Meili client; MCP tool modules load
// this file at boot, so it is required at call time (mcp/tools/index.js).
const search = () => require('./search');

const REJECT_REASON_MAX = 500;
const LABEL_SCAN_MSG = 'A label scan is private curation evidence, not a wine image';

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const viaDetail = (via) => (via ? { via } : {});

// A photo uploaded on a bottle carries no wine of its own — the bottle does.
// Publishing it (approved + public) makes it a photo OF THE WINE: every owner
// of that wine sees it in their gallery and can pick it as their bottle's
// picture, and it can become the wine's registry image. Until 2026-09-27 the
// approve and visibility routes left the wine reference empty, so a published
// bottle photo was visible on that one bottle only, never reached the wine,
// and approving from the queue needed a second "assign to wine" click.
// Resolves the wine through the bottle when the row has none; a photo that
// already carries a wine (a wine-level upload) keeps it. Returns the wine id.
async function linkWineViaBottle(image) {
  if (image.wineDefinition || !image.bottle) return image.wineDefinition || null;
  const bottle = await Bottle.findById(image.bottle).select('wineDefinition').lean();
  if (bottle && bottle.wineDefinition) image.wineDefinition = bottle.wineDefinition;
  return image.wineDefinition || null;
}

/**
 * Approve a photo waiting in the queue.
 *
 * `official` decides whether it becomes the wine's picture:
 *   'auto'  — the admin page's rule: a public photo becomes the picture when
 *             the wine has none yet.
 *   true    — make it the picture. Refused (conflict, nothing written) when
 *             the wine already has one, unless `replaceMain` is set.
 *   false   — never. A back label is published in the gallery but must not
 *             become the picture just because it was approved first.
 */
async function approveImage({ imageId, actorId, visibility = 'public', official = 'auto', replaceMain = false, req, via }) {
  if (!isValidId(imageId)) return fail('invalid_input', 'Invalid ID');
  const image = await BottleImage.findById(imageId);
  if (!image) return fail('not_found', 'Image not found');
  if (!['processed', 'uploaded'].includes(image.status)) {
    return fail('invalid_input', 'Image cannot be approved in current state');
  }
  // Never a label scan (audit L-6): it is a private frame kept only so a
  // curator can read an unreadable label. Promoting one to a wine's official
  // image makes it public AND sets assignedToWine, which moves it out of the
  // delete branch of account deletion into the anonymise branch, so the
  // uploader's own photo would outlive their account, reattributed.
  if (image.kind === 'label-scan') return fail('invalid_input', LABEL_SCAN_MSG);
  if (!['private', 'public'].includes(visibility)) {
    return fail('invalid_input', 'visibility must be "private" or "public"');
  }
  if (official === true && visibility !== 'public') {
    return fail('invalid_input', 'Only a public photo can be the wine\'s picture');
  }

  // An explicit "make it the picture" is checked before anything is written,
  // so a refusal leaves the photo in the queue exactly as it was.
  let explicitWine = null;
  let replacedImage = null;
  if (official === true) {
    const wineDefId = await linkWineViaBottle(image);
    explicitWine = wineDefId ? await WineDefinition.findById(wineDefId) : null;
    if (!explicitWine) return fail('conflict', 'Image is not linked to a wine');
    if (explicitWine.image) {
      if (!replaceMain) {
        return fail('conflict', 'The wine already has a picture', { currentPicture: explicitWine.image });
      }
      replacedImage = explicitWine.image;
    }
  }

  image.status = 'approved';
  image.visibility = visibility;
  image.reviewedBy = actorId;
  image.reviewedAt = new Date();
  // Approving a REPORTED photo is the answer to that report: clear the
  // needs-a-look flag, but keep the reports themselves so a photo raised
  // repeatedly still shows its history (ticket 6a865f60).
  image.reportedAt = null;
  // Published: the photo belongs to the wine from here on (linkWineViaBottle).
  // A private approval stays the uploader's own bottle photo.
  if (visibility === 'public') await linkWineViaBottle(image);
  await discardOriginal(image);
  await image.save();

  // Approved before rembg got to it (a failed run, or rembg down at upload):
  // kick the processor now — it accepts an approved row with no processed
  // file — rather than leave the raw frame as the image for good.
  if (!image.processedUrl && !image.keepBackground) {
    processImage(image._id).catch((err) => console.error('Post-approval processing error:', err.message));
  }

  incrementCred(image.uploadedBy, 'image_approved').catch(() => {});

  // Resolve the wine for the notification label regardless of visibility —
  // private approvals should still name the wine (the reject path does).
  // For a published bottle photo this is the wine linked above.
  const wineDefId = image.wineDefinition;
  const approvedWine = explicitWine || (wineDefId ? await WineDefinition.findById(wineDefId) : null);

  let madeOfficial = false;
  if (visibility === 'public' && wineDefId && approvedWine) {
    const assign = official === true || (official === 'auto' && !approvedWine.image);
    if (assign) {
      await BottleImage.updateMany(
        { wineDefinition: wineDefId, assignedToWine: true },
        { assignedToWine: false }
      );
      image.assignedToWine = true;
      await image.save();

      const imageUrl = image.processedUrl || image.originalUrl;
      await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl, imageCredit: image.credit || null });
      search().indexWine(wineDefId);
      madeOfficial = true;
      // The explicit choice is the set-official click in one step, so it
      // earns what set-official earns.
      if (official === true) incrementCred(image.uploadedBy, 'image_assigned_official').catch(() => {});
    }
  }

  const wineLabel = approvedWine
    ? `"${approvedWine.name}" by ${approvedWine.producer}`
    : 'a wine';
  createNotification(
    image.uploadedBy,
    'image_approved',
    'Image approved',
    `Your image for ${wineLabel} has been approved.`,
    null
  );

  logAudit(req, 'admin.image.approve',
    { type: 'image', id: image._id },
    {
      wineDefinitionId: image.wineDefinition, visibility,
      ...(official === true || official === false ? { official: madeOfficial } : {}),
      ...viaDetail(via),
    }
  );

  return { ok: true, image, wine: approvedWine, madeOfficial, replacedImage: madeOfficial ? replacedImage : null };
}

/**
 * Reject a photo: a moderation judgement that the photo itself is unwanted.
 * The files are deleted, a rejected tombstone record is kept, and the
 * uploader is notified — with the reason when one is given. For removing a
 * redundant duplicate silently, the admin route's DELETE is the tool instead.
 */
async function rejectImage({ imageId, actorId, reason, req, via }) {
  if (!isValidId(imageId)) return fail('invalid_input', 'Invalid ID');
  if (reason != null && typeof reason !== 'string') return fail('invalid_input', 'reason must be text');
  const reasonText = typeof reason === 'string' ? stripHtml(reason).trim() : '';
  if (reasonText.length > REJECT_REASON_MAX) {
    return fail('invalid_input', `reason must be ${REJECT_REASON_MAX} characters or fewer`);
  }
  const image = await BottleImage.findById(imageId);
  if (!image) return fail('not_found', 'Image not found');

  // If image was assigned to a wine, remove the assignment BEFORE the file
  // URLs are nulled below — otherwise WineDefinition.image keeps pointing
  // at the deleted file (same block as the unapprove route).
  if (image.assignedToWine && image.wineDefinition) {
    const wineDefId = image.wineDefinition;
    image.assignedToWine = false;

    // Clear the wine definition's image if it matches this image
    const imageUrl = image.processedUrl || image.originalUrl;
    const wine = await WineDefinition.findById(wineDefId);
    if (wine && wine.image === imageUrl) {
      wine.image = null;
      wine.imageCredit = null;
      await wine.save();
      search().indexWine(wineDefId);
    }
  }

  // A rejected photo shouldn't stay starred on any bottle — clear the refs so
  // they fall back to the wine image instead of dangling.
  await Bottle.updateMany({ defaultImage: image._id }, { $set: { defaultImage: null } });

  image.status = 'rejected';
  image.reviewedBy = actorId;
  image.reviewedAt = new Date();
  image.reportedAt = null;   // resolved — the photo is coming down

  // Delete the files from disk — reference-safe: import dedup can point two
  // records at the same file, and a shared file must survive for the record
  // that remains.
  await unlinkImageFiles(image);
  image.originalUrl = null;
  image.processedUrl = null;
  await image.save();

  // A bottle photo carries no wine of its own — name its bottle's wine, so
  // the uploader is not told about "a wine".
  const labelWineId = image.wineDefinition
    || (image.bottle ? (await Bottle.findById(image.bottle).select('wineDefinition').lean())?.wineDefinition : null)
    || null;
  const rejectedWine = labelWineId
    ? await WineDefinition.findById(labelWineId).select('name producer').lean()
    : null;
  const rejectedWineLabel = rejectedWine
    ? `"${rejectedWine.name}" by ${rejectedWine.producer}`
    : 'a wine';
  createNotification(
    image.uploadedBy,
    'image_rejected',
    'Image rejected',
    reasonText
      ? `Your image for ${rejectedWineLabel} was rejected. Reason: ${reasonText}`
      : `Your image for ${rejectedWineLabel} was rejected by an admin.`,
    null
  );

  logAudit(req, 'admin.image.reject',
    { type: 'image', id: image._id },
    { ...(reasonText ? { reason: reasonText } : {}), ...viaDetail(via) }
  );

  return { ok: true, image, wineId: labelWineId };
}

/**
 * Make a photo the wine's picture — the one-click "set official". Promotes
 * ANY non-rejected photo, approving and publishing it in the same step. The
 * web click always replaces the current picture; the MCP passes
 * `replaceMain: false` unless the curator chose to replace it.
 */
async function setOfficialImage({ imageId, actorId, replaceMain = true, clearReport = false, req, via }) {
  if (!isValidId(imageId)) return fail('invalid_input', 'Invalid ID');
  const image = await BottleImage.findById(imageId).populate('bottle', 'wineDefinition');
  if (!image) return fail('not_found', 'Image not found');
  if (image.status === 'rejected') return fail('invalid_input', 'Rejected images cannot be set as official');
  // Never a label scan (audit L-6) — see approveImage.
  if (image.kind === 'label-scan') return fail('invalid_input', LABEL_SCAN_MSG);

  const imageUrl = image.processedUrl || image.originalUrl;
  if (!imageUrl) return fail('invalid_input', 'Image has no file to use');

  const wineDefId = image.wineDefinition || image.bottle?.wineDefinition;
  if (!wineDefId) return fail('invalid_input', 'Image is not linked to a wine');

  // The picture this one replaces, read before anything is written so a
  // refusal leaves everything as it was.
  const current = await WineDefinition.findById(wineDefId).select('image').lean();
  const replacedImage = current && current.image && current.image !== imageUrl ? current.image : null;
  if (replacedImage && !replaceMain) {
    return fail('conflict', 'The wine already has a picture', { currentPicture: replacedImage });
  }

  // Demote the wine's current official image, if any (and not this one).
  await BottleImage.updateMany(
    { wineDefinition: wineDefId, assignedToWine: true, _id: { $ne: image._id } },
    { assignedToWine: false }
  );

  const wasOfficial = image.assignedToWine;
  image.wineDefinition = wineDefId;
  image.assignedToWine = true;
  image.status = 'approved';
  image.visibility = 'public';
  if (!image.reviewedBy) {
    image.reviewedBy = actorId;
    image.reviewedAt = new Date();
  }
  if (clearReport) {
    image.reportedAt = null;
    image.reviewedBy = actorId;
    image.reviewedAt = new Date();
  }
  // Drop a retained original once a processed version exists, same as the
  // approve path — imageUrl was resolved above before this nulls it.
  await discardOriginal(image);
  await image.save();

  await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl, imageCredit: image.credit || null });
  search().indexWine(wineDefId);

  // Reward the uploader the first time their image becomes official.
  if (!wasOfficial) incrementCred(image.uploadedBy, 'image_assigned_official').catch(() => {});

  logAudit(req, 'admin.image.setOfficial',
    { type: 'image', id: image._id },
    { wineDefinitionId: wineDefId, ...viaDetail(via) }
  );

  return { ok: true, image, wineDefinitionId: wineDefId, replacedImage };
}

/**
 * Change who sees an approved photo. Making it private takes it off the
 * wine's picture when it was that; making it public links it to the wine.
 * `clearReport` answers a report on the photo in the same step.
 */
async function setImageVisibility({ imageId, actorId, visibility, clearReport = false, req, via }) {
  if (!isValidId(imageId)) return fail('invalid_input', 'Invalid ID');
  const image = await BottleImage.findById(imageId);
  if (!image) return fail('not_found', 'Image not found');
  if (image.status !== 'approved') return fail('invalid_input', 'Only approved images can change visibility');
  if (!['private', 'public'].includes(visibility)) {
    return fail('invalid_input', 'visibility must be "private" or "public"');
  }

  // Made public: the photo belongs to the wine from here on (linkWineViaBottle).
  if (visibility === 'public') await linkWineViaBottle(image);

  // If changing to private, unassign from wine
  if (visibility === 'private' && image.assignedToWine && image.wineDefinition) {
    const imageUrl = image.processedUrl || image.originalUrl;
    const wine = await WineDefinition.findById(image.wineDefinition);
    if (wine && wine.image === imageUrl) {
      wine.image = null;
      wine.imageCredit = null;
      await wine.save();
      search().indexWine(image.wineDefinition);
    }
    image.assignedToWine = false;
  }

  image.visibility = visibility;
  if (clearReport) {
    image.reportedAt = null;
    image.reviewedBy = actorId;
    image.reviewedAt = new Date();
  }
  await image.save();

  logAudit(req, 'admin.image.visibility',
    { type: 'image', id: image._id },
    { visibility, ...(clearReport ? { reportCleared: true } : {}), ...viaDetail(via) }
  );

  return { ok: true, image };
}

/**
 * Answer a report with "the photo is fine as it is": the needs-a-look flag is
 * cleared, the reports themselves stay as history (ticket 6a865f60).
 */
async function dismissImageReport({ imageId, actorId, req, via }) {
  if (!isValidId(imageId)) return fail('invalid_input', 'Invalid ID');
  const image = await BottleImage.findById(imageId);
  if (!image) return fail('not_found', 'Image not found');
  if (!image.reportedAt) return fail('conflict', 'This photo has no open report');

  image.reportedAt = null;
  image.reviewedBy = actorId;
  image.reviewedAt = new Date();
  await image.save();

  logAudit(req, 'admin.image.reportDismissed',
    { type: 'image', id: image._id },
    { reports: Array.isArray(image.reports) ? image.reports.length : 0, ...viaDetail(via) }
  );

  return { ok: true, image };
}

module.exports = {
  REJECT_REASON_MAX,
  linkWineViaBottle,
  approveImage,
  rejectImage,
  setOfficialImage,
  setImageVisibility,
  dismissImageReport,
};
