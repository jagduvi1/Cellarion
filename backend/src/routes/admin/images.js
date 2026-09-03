const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const BottleImage = require('../../models/BottleImage');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const searchService = require('../../services/search');
const { unlinkImageFiles, discardOriginal } = require('../../services/imageProcessor');
const { logAudit } = require('../../services/audit');
const { createNotification } = require('../../services/notifications');
const { incrementCred } = require('../../utils/cellarCred');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/images - List images with optional status filter
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 100 });
    // Label scans are NOT moderation content (audit L-6). They are the private
    // original frame a user scanned, kept for one purpose — letting a curator
    // read an unreadable label — and they are never public. Surfacing them here
    // let an admin approve one as a wine's official image, which sets
    // assignedToWine and thereby moves it from the DELETE branch of account
    // deletion to the ANONYMISE branch (services/userDataRegistry): the user's
    // own photo would outlive their account, reattributed.
    const filter = { kind: { $ne: 'label-scan' } };
    const validStatuses = ['uploaded', 'processing', 'processed', 'approved', 'rejected'];
    if (status) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}` });
      }
      filter.status = status;
    }
    // ?reported=true — photos a user has raised (ticket 6a865f60). These are
    // mostly ALREADY approved, so they never appear under the pending filter an
    // admin normally works; without their own filter a report would sit unseen.
    // The label-scan exclusion above still holds and costs nothing here: a scan
    // is visible only to the person who took it, and they can delete it
    // outright, so there is no one who could report one.
    if (req.query.reported === 'true') filter.reportedAt = { $ne: null };

    const [images, total] = await Promise.all([
      BottleImage.find(filter)
        .populate({
          path: 'bottle',
          populate: { path: 'wineDefinition', select: 'name producer type' }
        })
        .populate('wineDefinition', 'name producer type')
        .populate('uploadedBy', 'username')
        .populate('reviewedBy', 'username')
        .populate('reports.user', 'username')
        // Reported photos first when that is what was asked for — a report is
        // a person waiting on an answer, unlike the rest of this queue.
        .sort(req.query.reported === 'true' ? { reportedAt: 1 } : { createdAt: -1 })
        .skip(offset)
        .limit(limit),
      BottleImage.countDocuments(filter)
    ]);

    res.json({ images, total, page, limit });
  } catch (error) {
    console.error('Get admin images error:', error);
    res.status(500).json({ error: 'Failed to get images' });
  }
});

// GET /api/admin/images/by-wine — wine-centric curation view.
// Lists wines that have 2+ non-rejected, file-backed images to choose between,
// with all of each wine's images so an admin can pick the official one.
router.get('/by-wine', async (req, res) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, { limit: 12, maxLimit: 50 });

    // An image belongs to a wine directly (wineDefinition) or via its bottle.
    const HAS_FILE = { $or: [{ processedUrl: { $ne: null } }, { originalUrl: { $ne: null } }] };
    const basePipeline = [
      // kind exclusion: same reason as GET / above (audit L-6).
      { $match: { status: { $ne: 'rejected' }, kind: { $ne: 'label-scan' }, ...HAS_FILE } },
      { $lookup: { from: 'bottles', localField: 'bottle', foreignField: '_id', as: '_b' } },
      { $addFields: { effWine: { $ifNull: ['$wineDefinition', { $arrayElemAt: ['$_b.wineDefinition', 0] }] } } },
      { $match: { effWine: { $ne: null } } },
      { $group: {
        _id: '$effWine',
        imageCount: { $sum: 1 },
        hasOfficial: { $max: { $cond: ['$assignedToWine', 1, 0] } },
      } },
      { $match: { imageCount: { $gte: 2 } } },
    ];

    const [countRes] = await BottleImage.aggregate([...basePipeline, { $count: 'total' }]);
    const total = countRes?.total || 0;

    const groups = await BottleImage.aggregate([
      ...basePipeline,
      // Wines still missing an official image first, then the most-contested.
      { $sort: { hasOfficial: 1, imageCount: -1, _id: 1 } },
      { $skip: offset },
      { $limit: limit },
    ]);

    const wineIds = groups.map(g => g._id);
    const wines = await WineDefinition.find({ _id: { $in: wineIds } })
      .select('name producer type image imageCredit')
      .lean();
    const wineMap = new Map(wines.map(w => [w._id.toString(), w]));

    // Bottles for these wines: their ids link bottle-only images, and their
    // count is shown per wine.
    const bottles = await Bottle.find({ wineDefinition: { $in: wineIds } })
      .select('_id wineDefinition').lean();
    const bottleToWine = new Map(bottles.map(b => [b._id.toString(), b.wineDefinition.toString()]));
    const bottleCount = {};
    for (const b of bottles) {
      const w = b.wineDefinition.toString();
      bottleCount[w] = (bottleCount[w] || 0) + 1;
    }

    const images = await BottleImage.find({
      status: { $ne: 'rejected' },
      kind: { $ne: 'label-scan' },
      $and: [
        HAS_FILE,
        { $or: [{ wineDefinition: { $in: wineIds } }, { bottle: { $in: bottles.map(b => b._id) } }] },
      ],
    })
      .populate('uploadedBy', 'username')
      .sort({ assignedToWine: -1, createdAt: -1 })
      .lean();

    const imagesByWine = new Map();
    for (const img of images) {
      const wid = (img.wineDefinition && img.wineDefinition.toString())
        || (img.bottle && bottleToWine.get(img.bottle.toString()));
      if (!wid || !wineMap.has(wid)) continue;
      if (!imagesByWine.has(wid)) imagesByWine.set(wid, []);
      imagesByWine.get(wid).push(img);
    }

    const items = groups
      // Skip wines that no longer exist (deleted with dangling images) — they'd
      // render as blank, image-less cards.
      .filter(g => wineMap.has(g._id.toString()) && (imagesByWine.get(g._id.toString()) || []).length > 0)
      .map(g => {
        const wid = g._id.toString();
        return {
          wine: wineMap.get(wid),
          imageCount: g.imageCount,
          bottleCount: bottleCount[wid] || 0,
          images: imagesByWine.get(wid),
        };
      });

    res.json({ items, total, page, limit });
  } catch (error) {
    console.error('Get images by-wine error:', error);
    res.status(500).json({ error: 'Failed to load wines by image' });
  }
});

// Dropping a retained original on approval goes through the shared
// services/imageProcessor.discardOriginal. The processor now discards it right
// after rembg succeeds, so this only still matters for rows processed before
// that. The inline unlink that used to live here deleted the file whenever
// both URLs were set — including a keepBackground row, whose "original" IS the
// kept file — and left processedUrl pointing at nothing.

// PUT /api/admin/images/:id/approve
// Body: { visibility: 'private' | 'public' } — defaults to 'public'
router.put('/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (!['processed', 'uploaded'].includes(image.status)) {
      return res.status(400).json({ error: 'Image cannot be approved in current state' });
    }
    // Never a label scan (audit L-6): it is a private frame kept only so a
    // curator can read an unreadable label. Promoting one to a wine's official
    // image makes it public AND sets assignedToWine, which moves it out of the
    // delete branch of account deletion into the anonymise branch, so the
    // uploader's own photo would outlive their account, reattributed.
    if (image.kind === 'label-scan') {
      return res.status(400).json({ error: 'A label scan is private curation evidence, not a wine image' });
    }

    const visibility = req.body.visibility || 'public';
    if (!['private', 'public'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be "private" or "public"' });
    }

    image.status = 'approved';
    image.visibility = visibility;
    image.reviewedBy = req.user.id;
    image.reviewedAt = new Date();
    // An admin approving a REPORTED photo is the answer to that report: clear
    // the needs-a-look flag, but keep the reports themselves so a photo raised
    // repeatedly still shows its history (ticket 6a865f60).
    image.reportedAt = null;
    await discardOriginal(image);
    await image.save();

    // Award Cellar Cred to the uploader
    incrementCred(image.uploadedBy, 'image_approved').catch(() => {});

    // Resolve the wine for the notification label regardless of visibility —
    // private approvals should still name the wine (the reject path does).
    const wineDefId = image.wineDefinition;
    const approvedWine = wineDefId ? await WineDefinition.findById(wineDefId) : null;

    // Auto-assign as wine image if public and the wine doesn't already have one
    if (visibility === 'public' && wineDefId) {
      if (approvedWine && !approvedWine.image) {
        await BottleImage.updateMany(
          { wineDefinition: wineDefId, assignedToWine: true },
          { assignedToWine: false }
        );
        image.assignedToWine = true;
        await image.save();

        const imageUrl = image.processedUrl || image.originalUrl;
        await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl, imageCredit: image.credit || null });
        searchService.indexWine(wineDefId);
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

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.approve',
      { type: 'image', id: image._id },
      { wineDefinitionId: image.wineDefinition, visibility }
    );

    res.json({ image });
  } catch (error) {
    console.error('Approve image error:', error);
    res.status(500).json({ error: 'Failed to approve image' });
  }
});

// PUT /api/admin/images/:id/reject — moderation judgement: the photo itself is
// unwanted. Notifies the uploader and keeps a rejected tombstone record. For
// removing redundant duplicates, use DELETE /:id below instead.
router.put('/:id/reject', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

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
        searchService.indexWine(wineDefId);
      }
    }

    // A rejected photo shouldn't stay starred on any bottle — clear the refs so
    // they fall back to the wine image instead of dangling.
    await Bottle.updateMany({ defaultImage: image._id }, { $set: { defaultImage: null } });

    image.status = 'rejected';
    image.reviewedBy = req.user.id;
    image.reviewedAt = new Date();
    image.reportedAt = null;   // resolved — the photo is coming down

    // Delete the files from disk — reference-safe: import dedup can point two
    // records at the same file, and a shared file must survive for the record
    // that remains.
    await unlinkImageFiles(image);
    image.originalUrl = null;
    image.processedUrl = null;
    await image.save();

    const rejectedWine = image.wineDefinition
      ? await WineDefinition.findById(image.wineDefinition).select('name producer').lean()
      : null;
    const rejectedWineLabel = rejectedWine
      ? `"${rejectedWine.name}" by ${rejectedWine.producer}`
      : 'a wine';
    createNotification(
      image.uploadedBy,
      'image_rejected',
      'Image rejected',
      `Your image for ${rejectedWineLabel} was rejected by an admin.`,
      null
    );

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' }
    ]);

    logAudit(req, 'admin.image.reject',
      { type: 'image', id: image._id },
      {}
    );

    res.json({ image });
  } catch (error) {
    console.error('Reject image error:', error);
    res.status(500).json({ error: 'Failed to reject image' });
  }
});

// DELETE /api/admin/images/:id — silent housekeeping removal (duplicate cleanup
// in the by-wine view). Unlike reject, this is not a judgement on the photo:
// the record is removed entirely, the uploader is NOT notified, and anything
// still pointing at it — a bottle's starred default image or the wine's
// official image — is handed over to a byte-identical surviving copy when one
// exists, so no user visibly loses a photo.
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    // Byte-identical surviving copy (duplicates from imports / re-uploads).
    // Prefer one by the same uploader — in practice duplicates are the same
    // user re-importing their cellar.
    let survivor = null;
    if (image.contentHash) {
      const candidates = await BottleImage.find({
        _id: { $ne: image._id },
        contentHash: image.contentHash,
        status: { $ne: 'rejected' },
        // Never a label scan. The promotion below sets approved+public, and a
        // user who scanned a label and also uploaded that same file as a bottle
        // photo has two rows with an identical contentHash — with the
        // same-uploader preference right below actively selecting the scanner's
        // own row. That would publish private curation evidence to a URL that
        // /api/uploads serves unauthenticated and forever.
        kind: { $ne: 'label-scan' },
        $or: [{ processedUrl: { $ne: null } }, { originalUrl: { $ne: null } }],
      }).sort({ createdAt: 1 }).lean();
      survivor = candidates.find(c => String(c.uploadedBy) === String(image.uploadedBy)) || candidates[0] || null;
    }

    // Hand the official-image assignment over to the identical copy (or clear
    // it) BEFORE the files go away, so WineDefinition.image never points at a
    // deleted file.
    if (image.assignedToWine && image.wineDefinition) {
      const wineDefId = image.wineDefinition;
      const imageUrl = image.processedUrl || image.originalUrl;
      const wine = await WineDefinition.findById(wineDefId);
      if (wine && wine.image === imageUrl) {
        if (survivor) {
          // Mirrors the set-official promotion.
          await BottleImage.updateOne(
            { _id: survivor._id },
            { $set: { wineDefinition: wineDefId, assignedToWine: true, status: 'approved', visibility: 'public' } }
          );
          wine.image = survivor.processedUrl || survivor.originalUrl;
          wine.imageCredit = survivor.credit || null;
        } else {
          wine.image = null;
          wine.imageCredit = null;
        }
        await wine.save();
        searchService.indexWine(wineDefId);
      }
    }

    // Repoint bottles whose starred (default) image is this record to the
    // surviving identical copy — or clear it so it falls back to the wine
    // image instead of dangling.
    await Bottle.updateMany(
      { defaultImage: image._id },
      { $set: { defaultImage: survivor ? survivor._id : null } }
    );

    // Remove the files (reference-safe: a file shared with another record via
    // import dedup survives for that record), then drop the record itself.
    await unlinkImageFiles(image);
    await image.deleteOne();

    logAudit(req, 'admin.image.delete',
      { type: 'image', id: image._id },
      { wineDefinitionId: image.wineDefinition || null, survivorId: survivor ? survivor._id : null }
    );

    res.json({ ok: true, survivorId: survivor ? survivor._id : null });
  } catch (error) {
    console.error('Delete image error:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// PUT /api/admin/images/:id/unapprove - Revert approved image back to processed
router.put('/:id/unapprove', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (image.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved images can be unapproved' });
    }

    // If image was assigned to a wine, remove the assignment
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
        searchService.indexWine(wineDefId);
      }
    }

    image.status = image.processedUrl ? 'processed' : 'uploaded';
    image.reviewedBy = req.user.id;
    image.reviewedAt = new Date();
    await image.save();

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.unapprove',
      { type: 'image', id: image._id },
      { wineDefinitionId: image.wineDefinition }
    );

    res.json({ image });
  } catch (error) {
    console.error('Unapprove image error:', error);
    res.status(500).json({ error: 'Failed to unapprove image' });
  }
});

// PUT /api/admin/images/:id/assign-to-wine - Set as official wine image
router.put('/:id/assign-to-wine', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (image.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved images can be assigned to a wine' });
    }
    // Never a label scan (audit L-6): it is a private frame kept only so a
    // curator can read an unreadable label. Promoting one to a wine's official
    // image makes it public AND sets assignedToWine, which moves it out of the
    // delete branch of account deletion into the anonymise branch, so the
    // uploader's own photo would outlive their account, reattributed.
    if (image.kind === 'label-scan') {
      return res.status(400).json({ error: 'A label scan is private curation evidence, not a wine image' });
    }

    // wineDefinitionId comes from the request body — validate it as an ObjectId
    // before it flows into updateMany/findByIdAndUpdate filters. Without this,
    // {"$ne":null} would clear the official-image flag platform-wide.
    let wineDefId = image.wineDefinition;
    if (req.body.wineDefinitionId !== undefined) {
      if (!isValidId(req.body.wineDefinitionId)) {
        return res.status(400).json({ error: 'Invalid wineDefinitionId' });
      }
      wineDefId = req.body.wineDefinitionId;
    }
    if (!wineDefId) {
      return res.status(400).json({ error: 'No wine definition to assign to' });
    }

    // Unset previous assignment for this wine
    await BottleImage.updateMany(
      { wineDefinition: wineDefId, assignedToWine: true },
      { assignedToWine: false }
    );

    // Set this image as official. Assigning an image to the public wine page
    // implicitly publishes it, so flip visibility too — otherwise an
    // approved-but-private image would be served as the wine detail/og:image
    // while GET /api/images/wine/:id still hides it (audit L-7; mirrors
    // set-official below).
    image.assignedToWine = true;
    image.wineDefinition = wineDefId;
    image.visibility = 'public';
    await image.save();

    // Award Cellar Cred for official wine image assignment
    incrementCred(image.uploadedBy, 'image_assigned_official').catch(() => {});

    // Update WineDefinition.image to the processed URL (or original if not processed)
    const imageUrl = image.processedUrl || image.originalUrl;
    await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl, imageCredit: image.credit || null });

    // Update search index
    searchService.indexWine(wineDefId);

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.assign',
      { type: 'image', id: image._id },
      { wineDefinitionId: wineDefId }
    );

    res.json({ image });
  } catch (error) {
    console.error('Assign image error:', error);
    res.status(500).json({ error: 'Failed to assign image to wine' });
  }
});

// PUT /api/admin/images/:id/set-official — one-click "make this the wine's image".
// Unlike assign-to-wine, this promotes ANY non-rejected image (approving +
// making it public in the same step), so an admin can curate directly from the
// by-wine view without a separate approval pass.
router.put('/:id/set-official', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const image = await BottleImage.findById(req.params.id).populate('bottle', 'wineDefinition');
    if (!image) return res.status(404).json({ error: 'Image not found' });
    if (image.status === 'rejected') {
      return res.status(400).json({ error: 'Rejected images cannot be set as official' });
    }
    // Never a label scan (audit L-6): it is a private frame kept only so a
    // curator can read an unreadable label. Promoting one to a wine's official
    // image makes it public AND sets assignedToWine, which moves it out of the
    // delete branch of account deletion into the anonymise branch, so the
    // uploader's own photo would outlive their account, reattributed.
    if (image.kind === 'label-scan') {
      return res.status(400).json({ error: 'A label scan is private curation evidence, not a wine image' });
    }

    const imageUrl = image.processedUrl || image.originalUrl;
    if (!imageUrl) return res.status(400).json({ error: 'Image has no file to use' });

    const wineDefId = image.wineDefinition || image.bottle?.wineDefinition;
    if (!wineDefId) return res.status(400).json({ error: 'Image is not linked to a wine' });

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
      image.reviewedBy = req.user.id;
      image.reviewedAt = new Date();
    }
    // Drop a retained original once a processed version exists, same as the
    // approve path — imageUrl was resolved above before this nulls it.
    await discardOriginal(image);
    await image.save();

    await WineDefinition.findByIdAndUpdate(wineDefId, { image: imageUrl, imageCredit: image.credit || null });
    searchService.indexWine(wineDefId);

    // Reward the uploader the first time their image becomes official.
    if (!wasOfficial) incrementCred(image.uploadedBy, 'image_assigned_official').catch(() => {});

    logAudit(req, 'admin.image.setOfficial',
      { type: 'image', id: image._id },
      { wineDefinitionId: wineDefId }
    );

    res.json({ ok: true });
  } catch (error) {
    console.error('Set official image error:', error);
    res.status(500).json({ error: 'Failed to set official image' });
  }
});

// PUT /api/admin/images/:id/visibility - Change visibility of an approved image
router.put('/:id/visibility', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const image = await BottleImage.findById(req.params.id);
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    if (image.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved images can change visibility' });
    }

    const { visibility } = req.body;
    if (!['private', 'public'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be "private" or "public"' });
    }

    // If changing to private, unassign from wine
    if (visibility === 'private' && image.assignedToWine && image.wineDefinition) {
      const imageUrl = image.processedUrl || image.originalUrl;
      const wine = await WineDefinition.findById(image.wineDefinition);
      if (wine && wine.image === imageUrl) {
        wine.image = null;
        wine.imageCredit = null;
        await wine.save();
        searchService.indexWine(image.wineDefinition);
      }
      image.assignedToWine = false;
    }

    image.visibility = visibility;
    await image.save();

    await image.populate([
      { path: 'uploadedBy', select: 'username' },
      { path: 'reviewedBy', select: 'username' },
      { path: 'wineDefinition', select: 'name producer type' }
    ]);

    logAudit(req, 'admin.image.visibility',
      { type: 'image', id: image._id },
      { visibility }
    );

    res.json({ image });
  } catch (error) {
    console.error('Change visibility error:', error);
    res.status(500).json({ error: 'Failed to change image visibility' });
  }
});

module.exports = router;
