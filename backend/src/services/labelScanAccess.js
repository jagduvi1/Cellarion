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

module.exports = {
  PROMOTED_SCAN_GRACE_DAYS,
  promotedScanDeadline,
  isWithinPromotedGrace,
  mayCurationReadScan,
};
