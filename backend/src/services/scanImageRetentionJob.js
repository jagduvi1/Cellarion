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
 * commit) or a bottle.
 *
 * THREE CLOCKS, disjoint by construction (the first two by their predicates,
 * the third by `kind`):
 *   30 days, UNATTACHED  — the sweep described above: a scan that never became
 *                          part of any record (runUnattachedScanSweep).
 *    7 days, PROMOTED    — a scan whose wine is NOT in the pending-identity
 *                          queue (runPromotedScanExpirySweep). Purpose-bound:
 *                          it stays readable to curation for a week so a wrong
 *                          identity can be corrected against the label, and
 *                          is then deleted — files, document, and the wine's
 *                          scanImage pointer. See services/labelScanAccess.
 *                          Two populations, one clock: a row that LEFT the
 *                          queue (stamped by the promotion hook) and, since
 *                          2026-08-13, a scan-originated row that was never in
 *                          it — minted looking complete and stamped at birth by
 *                          services/wineCommit. The quiet failures are the ones
 *                          whose label a curator most needs; the window is what
 *                          bounds the retention, not queue membership.
 *   30 days, ORPHAN PHOTO — an ordinary bottle photo (kind:'bottle') attached
 *                          to nothing, from an add abandoned between the
 *                          upload and the link (runUnattachedBottleImageSweep,
 *                          2026-08-16). Until it existed, nothing swept these
 *                          and they sat in the admin moderation queue reading
 *                          as images belonging to nothing.
 * A scan on a wine that is STILL pending is on none of the clocks: it is
 * attached, and it has no retainUntil until the row promotes.
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
    // `$type: 'date'` rather than `$ne: null` — identical semantics here (the
    // field is a Date or null), but it matches the index's
    // partialFilterExpression exactly, so the planner can prove the partial
    // index covers this query (models/BottleImage, audit L-10).
    retainUntil: { $type: 'date', $lt: now },
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
    // `$type: 'date'` rather than `$ne: null` — identical semantics here (the
    // field is a Date or null), but it matches the index's
    // partialFilterExpression exactly, so the planner can prove the partial
    // index covers this query (models/BottleImage, audit L-10).
    retainUntil: { $type: 'date', $lt: now },
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
    //
    // A wine added through the back-label rescue points at TWO frames, and the
    // expiring image may be either one. TWO matched updates rather than one
    // blanket write: each nulls only the pointer that actually names a deleted
    // image, so a wine whose front scan went and whose back scan did not keeps
    // the back pointer it still has. (They carry the same deadline today, but a
    // sweep that assumed so would drop a live pointer the first time that stops
    // being true — e.g. a back scan added later, on the creator's own row.)
    //
    // scanFieldConflicts goes with them: "front said X, back said Y" is a
    // statement ABOUT those photos, and evidence that outlives the images it
    // refers to cannot be checked. GDPR — this is retention enforcement, so
    // everything the window covers expires together.
    await WineDefinition.updateMany(
      { scanImage: { $in: gone } },
      { $set: { scanImage: null, scanFieldConflicts: [] } }
    );
    await WineDefinition.updateMany(
      { scanImageBack: { $in: gone } },
      { $set: { scanImageBack: null, scanFieldConflicts: [] } }
    );
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
 * The THIRD clock: an ordinary bottle PHOTO attached to nothing (2026-08-16).
 *
 * The add-bottle flow uploads the photo before the bottle exists — POST
 * /api/images/upload deliberately requires neither a bottle nor a wine, and
 * POST /api/images/link-to-bottle binds it once the commit succeeds. A user
 * who abandons the add between those two steps leaves a photo behind with no
 * bottle and no wine, and until now NOTHING swept it: the two clocks above
 * only ever consider kind:'label-scan'. Such a row also enters the admin
 * moderation queue, where it reads as an image belonging to nothing.
 *
 * Same GDPR argument as the unattached-scan sweep, and the same 30-day window
 * for the same reason: an image that never became part of a record has no
 * purpose to justify keeping it, but a user may reasonably photograph today
 * and finish the add next weekend.
 *
 * DISJOINT from both clocks above by the kind filter, and narrower than it
 * needs to be on purpose:
 *   - `wineDefinition: null` keeps every wine-level image out, including the
 *     official ones services/bottleOps deliberately DETACHES from a deleted
 *     bottle (`assignedToWine: true` → `bottle: null`); those carry a wine and
 *     are never orphans.
 *   - `assignedToWine: { $ne: true }` is the belt to that brace — an image
 *     serving as some wine's official photo is never swept, whatever its
 *     other fields say.
 * Rejected rows ARE swept: a rejected photo attached to nothing is exactly
 * what this window exists to clear.
 */
async function runUnattachedBottleImageSweep() {
  const cutoff = new Date(Date.now() - SCAN_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const selector = {
    kind: { $ne: 'label-scan' },
    wineDefinition: null,
    bottle: null,
    assignedToWine: { $ne: true },
    createdAt: { $lt: cutoff },
  };
  const stale = await BottleImage.find(selector)
    .select('originalUrl processedUrl')
    .limit(SWEEP_LIMIT)
    .lean();

  if (stale.length === 0) return { deleted: 0 };

  for (const img of stale) {
    try { await unlinkImageFiles(img); } catch (err) {
      console.warn('[scanImageRetention] unlink failed (continuing):', err.message);
    }
  }
  // Predicate REPEATED in the delete, same reason as the sweep above (audit
  // L-1): a user can link one of these to a bottle between the find and the
  // delete — /link-to-bottle is a plain updateMany — and deleting by id alone
  // would drop a row a live bottle now points at.
  const res = await BottleImage.deleteMany({
    _id: { $in: stale.map((i) => i._id) },
    ...selector,
  });
  const deleted = res.deletedCount || 0;
  if (deleted > 0) {
    console.log(
      `[scanImageRetention] Deleted ${deleted} unattached bottle photo(s) older than ${SCAN_IMAGE_RETENTION_DAYS} days`
    );
  }
  return { deleted };
}

/**
 * The daily entry point — all three clocks. The first two select disjoint rows
 * (an unattached scan has no wine and therefore no promotion deadline, and a
 * promoted scan has a wine); the third is disjoint from both by `kind`.
 */
async function runScanImageRetentionSweep() {
  const { deleted } = await runUnattachedScanSweep();
  const { expired } = await runPromotedScanExpirySweep();
  const { deleted: orphanPhotos } = await runUnattachedBottleImageSweep();
  return { deleted, expired, orphanPhotos };
}

module.exports = {
  runScanImageRetentionSweep,
  runUnattachedScanSweep,
  runPromotedScanExpirySweep,
  runUnattachedBottleImageSweep,
  SCAN_IMAGE_RETENTION_DAYS,
  PROMOTED_SCAN_GRACE_DAYS,
};
