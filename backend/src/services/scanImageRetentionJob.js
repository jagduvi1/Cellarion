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
 *
 * TWO CLOCKS, disjoint by construction:
 *   30 days, UNATTACHED  — the sweep described above: a scan that never became
 *                          part of any record (runUnattachedScanSweep).
 *    7 days, PROMOTED    — a scan whose wine has LEFT the pending-identity
 *                          queue (runPromotedScanExpirySweep). Purpose-bound:
 *                          it stays readable to curation for a week so a wrong
 *                          completion can be corrected against the label, and
 *                          is then deleted — files, document, and the wine's
 *                          scanImage pointer. See services/labelScanAccess.
 * A scan on a wine that is STILL pending is on neither clock: it is attached,
 * and it has no retainUntil until the row promotes.
 */
const BottleImage = require('../models/BottleImage');
const { unlinkImageFiles } = require('./imageProcessor');
const { PROMOTED_SCAN_GRACE_DAYS } = require('./labelScanAccess');

const SCAN_IMAGE_RETENTION_DAYS = 30;
// Bounded per run so one sweep can never hold the event loop for minutes on an
// instance that has accumulated a backlog; the next run picks up the rest.
const SWEEP_LIMIT = 500;

/**
 * The SECOND clock, added with the promotion grace window: a label scan whose
 * wine has LEFT the pending queue and whose 7 days are up.
 *
 * Distinct from the sweep below in every respect and therefore its own pass:
 * that one deletes scans attached to NOTHING after 30 days; this one deletes
 * scans attached to a wine that no longer needs them. A scan on a wine that is
 * still pending carries no retainUntil at all and can never be picked up here —
 * the queue is its purpose, and the queue has no deadline.
 *
 * GDPR: this REDUCES retention. Before, an attached scan was kept for good
 * (unreachable, but kept); now it is deleted 7 days after the identity it
 * documented was completed.
 *
 * Same TOCTOU-safe shape as the sweep below (audit L-1): the selection
 * predicate is REPEATED in the delete, so a row whose deadline was cleared
 * between the two (a wine returned to the queue) is silently skipped rather
 * than dropped out from under a live pointer. The wine's `scanImage` pointer is
 * nulled AFTER the delete, and only for rows that actually went — never
 * nulling a pointer to a document that survived.
 */
async function runPromotedScanExpirySweep() {
  const now = new Date();
  const expired = await BottleImage.find({
    kind: 'label-scan',
    retainUntil: { $ne: null, $lt: now },
  })
    .select('originalUrl processedUrl')
    .limit(SWEEP_LIMIT)
    .lean();

  if (expired.length === 0) return { expired: 0 };

  for (const img of expired) {
    try { await unlinkImageFiles(img); } catch (err) {
      console.warn('[scanImageRetention] unlink failed (continuing):', err.message);
    }
  }
  const ids = expired.map((i) => i._id);
  const res = await BottleImage.deleteMany({
    _id: { $in: ids },
    kind: 'label-scan',
    retainUntil: { $ne: null, $lt: now },
  });
  const deleted = res.deletedCount || 0;

  // Null the pointers of the rows that ACTUALLY went. Computed by asking which
  // ids survived rather than assuming the delete matched everything it was
  // handed — the repeated predicate above exists precisely because it might not.
  const survivors = await BottleImage.find({ _id: { $in: ids } }).select('_id').lean();
  const survived = new Set(survivors.map((s) => String(s._id)));
  const gone = ids.filter((id) => !survived.has(String(id)));
  if (gone.length > 0) {
    // Lazy require: this module is loaded by the scheduler at boot, and the
    // registry model drags a larger tree than a retention sweep needs.
    const WineDefinition = require('../models/WineDefinition');
    // updateOne-style $set, never a save(): re-validating a whole registry row
    // from a cleanup job is how an unrelated field gets rewritten.
    await WineDefinition.updateMany({ scanImage: { $in: gone } }, { $set: { scanImage: null } });
  }
  if (deleted > 0) {
    console.log(
      `[scanImageRetention] Deleted ${deleted} promoted label scan(s) past their ${PROMOTED_SCAN_GRACE_DAYS}-day grace window`
    );
  }
  return { expired: deleted };
}

async function runUnattachedScanSweep() {
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
  // The selection predicate is REPEATED in the delete (audit L-1). Between the
  // find above and this delete, a second bottle of the same unidentified wine
  // can attach one of these scans (services/wineCommit.attachScanImage stamps
  // it on the wine) — deleting by id alone would then drop the row a live
  // WineDefinition.scanImage points at. Re-asserting the filter makes the
  // delete a no-op for any row that stopped being unattached.
  const res = await BottleImage.deleteMany({
    _id: { $in: stale.map((i) => i._id) },
    kind: 'label-scan',
    wineDefinition: null,
    bottle: null,
    createdAt: { $lt: cutoff },
  });
  const deleted = res.deletedCount || 0;
  if (deleted > 0) {
    console.log(
      `[scanImageRetention] Deleted ${deleted} unattached label scan(s) older than ${SCAN_IMAGE_RETENTION_DAYS} days`
    );
  }
  return { deleted };
}

/**
 * The daily entry point — both clocks, in the order that matters least (they
 * select disjoint rows: an unattached scan has no wine and therefore no
 * promotion deadline, and a promoted scan has a wine).
 */
async function runScanImageRetentionSweep() {
  const { deleted } = await runUnattachedScanSweep();
  const { expired } = await runPromotedScanExpirySweep();
  return { deleted, expired };
}

module.exports = {
  runScanImageRetentionSweep,
  runUnattachedScanSweep,
  runPromotedScanExpirySweep,
  SCAN_IMAGE_RETENTION_DAYS,
  PROMOTED_SCAN_GRACE_DAYS,
};
