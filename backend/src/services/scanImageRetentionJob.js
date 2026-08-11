/**
 * Label-scan retention sweep — runs daily via the scheduler.
 *
 * POST /api/wines/scan-label now KEEPS the frame it scanned (services/imageOps
 * .persistLabelScan) so a curator working the pending-identity queue can read
 * the label the extraction got wrong. Most scans go on to become a bottle,
 * where services/wineCommit binds the image to the minted wine — but a user who
 * scans a bottle and then walks away leaves one behind, attached to nothing.
 *
 * GDPR storage limitation: an image that never became part of a record has no
 * purpose to justify keeping it, so it is deleted after 30 days. Same shape as
 * the ImportSession draft expiry (7 days of "abandoned work"), just longer —
 * a user may reasonably scan today and finish the add next weekend.
 *
 * A JOB rather than a Mongo TTL index, deliberately: these rows own FILES on
 * disk, and a TTL index deletes the document without unlinking anything, which
 * would leave the uploads volume growing forever with nothing referencing it.
 * (ImportSession's TTL is correct for ImportSession precisely because it has no
 * files.) Unlink first, then delete — the doc is the only reference to the file.
 *
 * BOUND: an image is "attached" once it carries a wineDefinition (set by the
 * commit) or a bottle. Only kind:'label-scan' rows are ever considered, so an
 * ordinary bottle photo can never be swept by this.
 */
const BottleImage = require('../models/BottleImage');
const { unlinkImageFiles } = require('./imageProcessor');

const SCAN_IMAGE_RETENTION_DAYS = 30;
// Bounded per run so one sweep can never hold the event loop for minutes on an
// instance that has accumulated a backlog; the next run picks up the rest.
const SWEEP_LIMIT = 500;

async function runScanImageRetentionSweep() {
  const cutoff = new Date(Date.now() - SCAN_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const stale = await BottleImage.find({
    kind: 'label-scan',
    wineDefinition: null,
    bottle: null,
    createdAt: { $lt: cutoff },
  })
    .select('originalUrl processedUrl')
    .limit(SWEEP_LIMIT)
    .lean();

  if (stale.length === 0) return { deleted: 0 };

  for (const img of stale) {
    // unlinkImageFiles refuses paths outside the uploads dir and skips a file
    // another BottleImage still references — safe to call per row.
    try { await unlinkImageFiles(img); } catch (err) {
      console.warn('[scanImageRetention] unlink failed (continuing):', err.message);
    }
  }
  const res = await BottleImage.deleteMany({ _id: { $in: stale.map((i) => i._id) } });
  const deleted = res.deletedCount || 0;
  if (deleted > 0) {
    console.log(
      `[scanImageRetention] Deleted ${deleted} unattached label scan(s) older than ${SCAN_IMAGE_RETENTION_DAYS} days`
    );
  }
  return { deleted };
}

module.exports = { runScanImageRetentionSweep, SCAN_IMAGE_RETENTION_DAYS };
