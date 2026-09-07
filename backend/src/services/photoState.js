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
const MAX_SCANS = 4; // label-scan frames of one wine by one viewer

// Same rule as routes/og.js and the frontend's getWineImageUrl: a stored image
// is a full URL, an /api/ path, or a bare upload filename.
const apiBase = () => (process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://cellarion.app').replace(/\/+$/, '');
function absoluteImageUrl(path) {
  if (!path || typeof path !== 'string') return null;
  // An inline data: image (a registry image copied verbatim from a wine
  // request) can be half a megabyte; it never travels in a tool result
  // (audit 2026-09-07) — the public wine page shows it.
  if (path.startsWith('data:')) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith('/') ? `${apiBase()}${path}` : `${apiBase()}/api/uploads/${path}`;
}
/** True when a stored image reference is an inline data: URL (see absoluteImageUrl). */
const isInlineImage = (path) => typeof path === 'string' && path.startsWith('data:');

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
  // Two bounded queries, own rows first: one query with a shared cap let a
  // wine with many published photos push the viewer's own row past the cap
  // — the very "did my upload land?" answer this exists for (audit 2026-09-07).
  const own = await BottleImage.find({
    ...NOT_SCAN, uploadedBy: userId,
    $or: [{ bottle: bottle._id }, ...(wineId ? [{ wineDefinition: wineId }] : [])],
  }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean();
  const published = wineId
    ? await BottleImage.find({
        ...NOT_SCAN, wineDefinition: wineId, status: 'approved', visibility: 'public', uploadedBy: { $ne: userId },
      }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean()
    : [];
  // The viewer's own label-scan frames of this wine (support ticket
  // 2026-09-07): never a "photo of the bottle" — kept out of items, count and
  // has_photo, the 2026-09-03 leak — but the sharpest image of the label
  // there is, and get_photo can now show it.
  const scans = wineId
    ? await BottleImage.find({ kind: 'label-scan', uploadedBy: userId, wineDefinition: wineId })
        .sort({ createdAt: -1 }).limit(MAX_SCANS).select('side createdAt').lean()
    : [];
  const items = [...own, ...published].map((r) => photoState(r, userId));
  const inline = wd && typeof wd === 'object' && isInlineImage(wd.image);
  const registryImage = wd && typeof wd === 'object' && wd.image ? absoluteImageUrl(wd.image) : null;
  return {
    count: items.length,
    has_photo: !!registryImage || inline || items.some((p) => p.state !== 'rejected' && !!p.url),
    mine_pending: items.filter((p) => p.mine && PENDING_STATES.includes(p.state)).length,
    registry_image: registryImage,
    ...(inline ? { registry_image_inline: true } : {}),
    ...(own.length >= MAX_ROWS || published.length >= MAX_ROWS ? { truncated: true } : {}),
    items,
    ...(scans.length
      ? { label_scans: scans.map((s) => ({ image_id: s._id, side: s.side === 'back' ? 'back' : 'front', scanned_at: s.createdAt || null })) }
      : {}),
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

module.exports = { STATE, PENDING_STATES, MAX_ROWS, absoluteImageUrl, isInlineImage, photoState, photosForBottle, photoPresence };
