/**
 * ONE definition of "may curation still read this label scan, and when does it
 * stop existing" — the purpose-bound grace window.
 *
 * THE GAP this closes: a label scan was kept forever and reachable only while
 * its wine was pendingIdentity. That is the worst of both worlds. The moment a
 * curator completed the identity the photo became unreadable, so a WRONG
 * completion could never be checked against the label again (the
 * "Increíble"/"Increíble" row reached the maturity queue in exactly this
 * state) — while the file itself sat on disk indefinitely with no purpose left
 * to justify it.
 *
 * The rule instead: a promoted wine's scan stays readable to curation for
 * PROMOTED_SCAN_GRACE_DAYS, then the file and the document are deleted and
 * WineDefinition.scanImage is nulled. Long enough for the correction pass that
 * follows a queue session, short enough to be a real retention limit.
 *
 * GDPR — this REDUCES retention, it does not extend it. Before: a promoted
 * wine's scan was kept INDEFINITELY (nothing ever deleted an attached scan; the
 * 30-day sweep only ever looked at scans attached to nothing). After: 7 days
 * from promotion, enforced by services/scanImageRetentionJob. No new consent
 * category, no new data, no change to export (the image still ships in GET
 * /api/users/me/export while it exists) or to account deletion. Scans on wines
 * that are STILL PENDING are untouched by this clock: they have a live purpose,
 * and the queue is the record of it.
 *
 * Lives in its own module, like services/wineVisibility, because the same
 * question is asked from three places that must not drift — the MCP tool
 * (mcp/tools/somm.get_pending_wine_images), the REST image gate
 * (routes/images.js) and the retention sweep.
 */

/**
 * How long a label scan outlives its wine's promotion.
 *
 * Named, not inlined: the sweep, the stamp and the tool description all state
 * it, and a window that means three different things in three files is not a
 * retention policy.
 */
const PROMOTED_SCAN_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The deadline to stamp when a wine leaves the pending queue. */
const promotedScanDeadline = (from = Date.now()) =>
  new Date(from + PROMOTED_SCAN_GRACE_DAYS * DAY_MS);

/**
 * Is this scan inside its post-promotion grace window?
 *
 * A null/absent retainUntil is NOT "expired" — it is "no clock has started",
 * which is every scan on a still-pending wine plus every row predating the
 * field. Those are governed by their wine's pending state, never by this.
 */
const isWithinPromotedGrace = (image, now = Date.now()) => {
  const until = image && image.retainUntil;
  if (!until) return false;
  return new Date(until).getTime() > now;
};

/**
 * May a CURATOR (somm/admin) read this label scan?
 *
 * @param {{pendingIdentity?: boolean}|null} wine  the wine the scan belongs to,
 *   or null when the scan is attached to none (a scan that never became a
 *   bottle — nobody's queue shows it, so curation has no claim on it; it is its
 *   uploader's private image until the 30-day unattached sweep takes it).
 * @param {{retainUntil?: Date|string|null}|null} image
 * @param {number} [now]
 * @returns {boolean}
 */
const mayCurationReadScan = (wine, image, now = Date.now()) => {
  if (!wine) return false;
  if (wine.pendingIdentity === true) return true;
  return isWithinPromotedGrace(image, now);
};

/**
 * Start the clock on one promoted wine's label scan.
 *
 * ONE implementation, called from the WineDefinition post('save') hook — i.e.
 * from the transition itself, so no write path can promote a row and forget
 * (audit M-4) — and, since 2026-08-13, from services/wineCommit for a wine that
 * was BORN promoted. That row makes no pending→promoted transition, so the hook
 * never fires for it; its correction window has to start at the mint instead.
 * Same window, same sweep, same idempotence.
 *
 * The hook exists because the admin PUT and /strip-producer both set a producer and
 * save(), the hook clears pendingIdentity, and neither route called the
 * follow-through: the scan became unreadable (the wine is no longer pending)
 * AND unsweepable (retainUntil null is excluded by the expiry sweep), leaving
 * the file on disk forever with no way to read it. That is precisely the "worst
 * of both worlds" this grace window exists to end.
 *
 * IDEMPOTENT by construction: the update matches only `retainUntil: null`, so a
 * second call — services/pendingWineOps.runPromotionFollowThrough still makes
 * one, deliberately, for the curation path — can never extend a live deadline.
 * Best-effort: a missed stamp leaves the scan on its old (indefinite) footing
 * and never deletes anything early.
 *
 * BOTH FRAMES: a wine added through the back-label rescue carries a front scan
 * AND a back scan, and they are one piece of evidence about one identity. A
 * stamp that reached only the front would leave the back frame on the old
 * indefinite footing — unreadable (curation access is gated on
 * pending-or-within-grace) and unsweepable (the expiry job excludes
 * retainUntil: null) — which is precisely the state this window exists to end.
 * One updateMany over both ids, not two calls, so they can never diverge.
 *
 * @param {{scanImage?: any, scanImageBack?: any}} wine
 */
const stampPromotedScanRetention = async (wine) => {
  const ids = [wine && wine.scanImage, wine && wine.scanImageBack].filter(Boolean);
  if (ids.length === 0) return;
  try {
    const BottleImage = require('../models/BottleImage');
    await BottleImage.updateMany(
      // Re-assert kind: nothing else in this collection may be given a
      // retention deadline by this path.
      { _id: { $in: ids }, kind: 'label-scan', retainUntil: null },
      { $set: { retainUntil: promotedScanDeadline() } }
    );
  } catch (err) {
    console.warn('[labelScanAccess] label-scan retention stamp failed (non-fatal):', err.message);
  }
};

/**
 * Record that a curator read somebody else's private bottle photo or label
 * scan. Owners' galleries are private; curation is the one purpose-bound
 * exception, so every such read must leave an audit row — on BOTH surfaces
 * (REST GET /api/images/:id and MCP get_pending_wine_images), through this
 * one helper so they can never diverge (audit 2026-09 M03-4). The row names
 * the wine and the image ids, never the bytes.
 */
const logCurationImageRead = (req, { wineId, imageIds, privateCount, scanCount, via }) => {
  try {
    const { logAudit } = require('./audit');
    logAudit(req, 'image.curation_read', { type: 'wine', id: wineId || null }, {
      imageIds: (imageIds || []).map(String),
      privateCount: privateCount || 0,
      scanCount: scanCount || 0,
      via,
    });
  } catch (err) {
    console.warn('[labelScanAccess] curation read audit failed (non-fatal):', err.message);
  }
};

module.exports = {
  PROMOTED_SCAN_GRACE_DAYS,
  promotedScanDeadline,
  isWithinPromotedGrace,
  mayCurationReadScan,
  stampPromotedScanRetention,
  logCurationImageRead,
};
