/**
 * Search-index reconciliation — runs nightly via the scheduler.
 *
 * PROD 2026-08-13: 567 of the 9,918 documents in the `bottles` index named
 * bottles that no longer existed in Mongo. Over MCP that read as "0 of 14";
 * across the ~9 callers in routes/cellars.js it produced phantom counts and
 * short pages.
 *
 * The cause was NOT a missing unindex call — every delete path already removes
 * its document. The debris was OPERATIONAL: a restore from backup rewound Mongo
 * while Meilisearch kept its own volume, and raw maintenance scripts deleted
 * rows without going through the models. Both will happen again, and neither is
 * something an application code path can be taught to prevent.
 *
 * So this job treats index membership as something to be RECONCILED rather than
 * assumed. It is the slow half of a two-part fix; the fast half is in
 * services/search.searchBottles, which verifies each page of hits against Mongo
 * and self-heals what it sees. That one keeps users honest results TODAY; this
 * one empties the index of everything nobody happened to search for, which is
 * also what makes the facet counts (an index-wide aggregation no per-page check
 * can correct) right again.
 *
 * DELETE-ONLY, deliberately: a document in the index whose Mongo row is gone is
 * unambiguous debris. The reverse — a Mongo row missing FROM the index — is
 * not: the wines index legitimately excludes pendingIdentity and nonWine rows,
 * and re-adding them from here would fight indexWine for ownership of index
 * membership. A missing document is what the admin force-reindex is for.
 *
 * BOTH INDEXES: `bottles` is where the prod damage was, but a restore rewinds
 * every collection, and a stale `wines` document is a registry row strangers can
 * find and open to a 404.
 *
 * The Meilisearch client lives in services/search — this module never requires
 * `meilisearch` itself (ESM-only; a second require is the #702 jest failure mode
 * again) and instead uses the paging/delete surface that module exports, which
 * every suite already knows how to mock.
 */
const searchService = require('./search');

// One page of ids per round trip. 1000 is well inside Meilisearch's document
// page limit and keeps the matching `$in` query on the Mongo side cheap.
const PAGE_SIZE = 1000;

// A ceiling per index per night. A sweep that wants to delete more than this is
// not cleaning up debris — it is reacting to something larger (an index pointed
// at the wrong database, a half-finished restore), and it should stop and be
// looked at rather than empty the index unattended. The next run picks up where
// this one stopped.
const MAX_DELETES_PER_INDEX = 5000;

// The two indexes and the collection each one mirrors.
const TARGETS = [
  { label: 'bottles', modelPath: '../models/Bottle' },
  { label: 'wines', modelPath: '../models/WineDefinition' },
];

/** Mongo _id shape. An index doc id that is not one cannot be looked up. */
const OBJECT_ID_RX = /^[a-f0-9]{24}$/i;

/**
 * Walk one index, deleting documents whose Mongo row is gone.
 *
 * PAGING IS SAFE ACROSS THE DELETES: deleteDocuments only ENQUEUES a
 * Meilisearch task, so documents do not disappear underneath the offset while
 * this loop is running. (If they did, the worst case is a skipped page, which
 * the next night's run picks up — never a wrong deletion.)
 *
 * @returns {Promise<{checked: number, removed: number, skipped: number}>}
 */
async function reconcileIndex({ label, modelPath }) {
  // Lazy require: the scheduler loads this module at boot and a reconcile sweep
  // has no reason to drag the model tree along until it actually runs.
  const Model = require(modelPath);
  let offset = 0;
  let checked = 0;
  let removed = 0;
  let skipped = 0;

  for (;;) {
    const { ids } = await searchService.listIndexDocumentIds(label, { limit: PAGE_SIZE, offset });
    if (ids.length === 0) break;
    checked += ids.length;

    // A non-ObjectId id would throw a CastError and take the whole sweep down.
    // Counted and LEFT ALONE rather than deleted: this job's one claim is
    // "Mongo does not have this", and an id it cannot look up is an id it
    // cannot make that claim about.
    const lookupIds = ids.filter(id => OBJECT_ID_RX.test(id));
    skipped += ids.length - lookupIds.length;

    if (lookupIds.length > 0) {
      const rows = await Model.find({ _id: { $in: lookupIds } }).select('_id').lean();
      if (rows.length !== lookupIds.length) {
        const live = new Set(rows.map(r => String(r._id)));
        const orphans = lookupIds.filter(id => !live.has(id));
        await searchService.deleteIndexDocuments(label, orphans);
        removed += orphans.length;
      }
    }

    if (ids.length < PAGE_SIZE) break;
    if (removed >= MAX_DELETES_PER_INDEX) {
      console.warn(
        `[searchReconcile] '${label}': stopped at the ${MAX_DELETES_PER_INDEX}-deletion ceiling — ` +
        'this looks like more than ordinary drift; check the index against the database'
      );
      break;
    }
    offset += PAGE_SIZE;
  }

  return { checked, removed, skipped };
}

/**
 * The nightly entry point. One index failing must not stop the other — they are
 * independent questions about independent collections.
 *
 * @returns {Promise<{checked: number, removed: number, skipped: number}>}
 */
async function runSearchIndexReconcile() {
  if (!searchService.getIsAvailable()) {
    console.log('[searchReconcile] Meilisearch unavailable — skipped');
    return { checked: 0, removed: 0, skipped: 0, ran: false };
  }

  const totals = { checked: 0, removed: 0, skipped: 0, ran: true };
  const perIndex = [];
  for (const target of TARGETS) {
    try {
      const res = await reconcileIndex(target);
      totals.checked += res.checked;
      totals.removed += res.removed;
      totals.skipped += res.skipped;
      perIndex.push(`${target.label} ${res.checked} checked/${res.removed} removed`);
    } catch (err) {
      console.error(`[searchReconcile] '${target.label}' failed:`, err.message);
      perIndex.push(`${target.label} FAILED`);
    }
  }

  // ONE line per night either way — a quiet one when there was nothing to do,
  // so a healthy instance is visibly healthy rather than silent.
  if (totals.removed > 0) {
    console.log(
      `[searchReconcile] Removed ${totals.removed} stale document(s) from the search indexes (${perIndex.join(', ')})`
    );
  } else {
    console.log(`[searchReconcile] Indexes in sync — ${totals.checked} document(s) checked`);
  }
  if (totals.skipped > 0) {
    console.warn(`[searchReconcile] ${totals.skipped} index document(s) have no ObjectId id and were left alone`);
  }
  return totals;
}

module.exports = {
  runSearchIndexReconcile,
  reconcileIndex,
  PAGE_SIZE,
  MAX_DELETES_PER_INDEX,
  TARGETS,
};
