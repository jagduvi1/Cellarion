/**
 * A photo's state as its OWNER sees it, for the MCP read path (support ticket
 * 2026-09-06: the connector could upload a photo but never see whether one
 * existed, was still processing, awaited review or had been rejected — so an
 * assistant answered "no pending changes" from the wrong queue, and could not
 * honour attach_bottle_image's "attach once per wine" rule because it had no
 * way to check first).
 *
 * The lifecycle lives in ONE status enum on BottleImage (models/BottleImage.js,
 * services/imageProcessor.js, routes/admin/images.js); this module only
 * translates it into words a caller can act on, and answers the two questions
 * a bottle read needs: which photos apply to this bottle, and whether a list
 * row has any photo at all. Visibility matches the web gallery: a viewer sees
 * their own rows in every state (rejected included — that is the answer they
 * were missing), and other people's rows only once published.
 */
const BottleImage = require('../models/BottleImage');

const STATE = {
  uploaded: 'queued',            // waiting for background removal (or a failed run, retried)
  processing: 'processing',      // background removal running
  processed: 'awaiting_review',  // shows on the owner's bottles; an admin decides on the registry
  approved: 'published',         // in the shared registry gallery
  rejected: 'rejected',          // declined by an admin; files deleted
};
const MEANING = {
  queued: 'waiting for background removal — usually seconds; a row stuck here is retried automatically after an hour',
  processing: 'background removal running',
  awaiting_review: 'already shows on your bottles; an admin decides whether it joins the shared registry gallery',
  published: 'in the shared registry gallery, visible on the public wine page',
  rejected: 'an admin declined it for the shared registry; it no longer shows anywhere',
};
const PENDING_STATES = ['queued', 'processing', 'awaiting_review'];
const LIVE_STATUSES = ['uploaded', 'processing', 'processed', 'approved'];
const NOT_SCAN = { kind: { $ne: 'label-scan' } };
const MAX_ROWS = 20;

// Same rule as routes/og.js and the frontend's getWineImageUrl: a stored image
// is a full URL, an /api/ path, or a bare upload filename.
const apiBase = () => (process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://cellarion.app').replace(/\/+$/, '');
function absoluteImageUrl(path) {
  if (!path || typeof path !== 'string') return null;
  if (/^https?:\/\//i.test(path) || path.startsWith('data:')) return path;
  return path.startsWith('/') ? `${apiBase()}${path}` : `${apiBase()}/api/uploads/${path}`;
}

/** One BottleImage row → the caller-facing shape. */
function photoState(img, userId) {
  const mine = img.uploadedBy != null && String(img.uploadedBy) === String(userId);
  const state = STATE[img.status] || img.status;
  return {
    image_id: img._id,
    state,
    meaning: MEANING[state] || null,
    mine,
    url: absoluteImageUrl(img.processedUrl || img.originalUrl),
    background_kept: img.keepBackground === true,
    shows_on_all_bottles_of_wine: !!img.wineDefinition,
    registry_image: img.assignedToWine === true,
    uploaded_at: img.createdAt || null,
    updated_at: img.updatedAt || null,
    // Review time only on the viewer's own rows — who reviewed never travels.
    ...(mine ? { reviewed_at: img.reviewedAt || null } : {}),
    credit: img.credit || null,
  };
}

/**
 * Every photo that applies to one bottle, from its viewer's side: the viewer's
 * own rows in ANY state (by bottle or by wine), plus other people's published
 * rows for the wine. Own rows first, newest first.
 * `bottle` may carry a populated wineDefinition (its `image` is the registry
 * image) or a bare id.
 */
async function photosForBottle(userId, bottle) {
  const wd = bottle.wineDefinition;
  const wineId = wd && (wd._id || wd);
  const own = { uploadedBy: userId, $or: [{ bottle: bottle._id }, ...(wineId ? [{ wineDefinition: wineId }] : [])] };
  const published = wineId
    ? { wineDefinition: wineId, status: 'approved', visibility: 'public', uploadedBy: { $ne: userId } }
    : null;
  const rows = await BottleImage.find({ ...NOT_SCAN, $or: published ? [own, published] : [own] })
    .sort({ createdAt: -1 }).limit(MAX_ROWS).lean();
  const items = rows.map((r) => photoState(r, userId))
    .sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1));
  const registryImage = wd && typeof wd === 'object' && wd.image ? absoluteImageUrl(wd.image) : null;
  return {
    count: items.length,
    has_photo: !!registryImage || items.some((p) => p.state !== 'rejected' && !!p.url),
    mine_pending: items.filter((p) => p.mine && PENDING_STATES.includes(p.state)).length,
    registry_image: registryImage,
    items,
  };
}

/**
 * has_photo per bottle id for one page of populated bottle docs — ONE query.
 * True when the viewer has a live photo on the bottle or its wine, when the
 * wine has a published photo from anyone, or when the registry record itself
 * carries an image.
 */
async function photoPresence(userId, docs) {
  const out = new Map();
  if (!docs.length) return out;
  const wineOf = (d) => d.wineDefinition && (d.wineDefinition._id || d.wineDefinition);
  const ids = docs.map((d) => d._id);
  const wineIds = [...new Set(docs.map(wineOf).filter(Boolean).map(String))];
  const rows = await BottleImage.find({
    ...NOT_SCAN,
    $or: [
      { uploadedBy: userId, status: { $in: LIVE_STATUSES }, $or: [{ bottle: { $in: ids } }, ...(wineIds.length ? [{ wineDefinition: { $in: wineIds } }] : [])] },
      ...(wineIds.length ? [{ wineDefinition: { $in: wineIds }, status: 'approved', visibility: 'public' }] : []),
    ],
  }).select('bottle wineDefinition').lean();
  const byBottle = new Set(rows.filter((r) => r.bottle).map((r) => String(r.bottle)));
  const byWine = new Set(rows.filter((r) => r.wineDefinition).map((r) => String(r.wineDefinition)));
  for (const d of docs) {
    const w = wineOf(d);
    const registry = !!(d.wineDefinition && typeof d.wineDefinition === 'object' && d.wineDefinition.image);
    out.set(String(d._id), byBottle.has(String(d._id)) || (!!w && byWine.has(String(w))) || registry);
  }
  return out;
}

module.exports = { STATE, PENDING_STATES, absoluteImageUrl, photoState, photosForBottle, photoPresence };
