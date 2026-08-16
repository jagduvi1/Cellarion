/**
 * COMPLETENESS scans: registry rows that are not wrong, just BLANK.
 *
 * Every other net in the registry keys off a value — a name that embeds its
 * producer, a producer that is really an appellation, two rows that collide on
 * a key. A row with an empty field trips none of them: it is silently, quietly
 * incomplete, and nothing has ever listed it. Measured on prod 2026-08-16:
 * 180 published rows carry no region at all, 123 carry neither region nor
 * appellation, and 112 of those have real bottles pointing at them.
 *
 * That gap has a specific source. The import path can only fill geography the
 * AI actually knows (and since v1.117.0 a low-confidence guess is dropped
 * rather than minted — correctly, but the row then lands blank), the scan path
 * fills what the label prints, and neither has a way to say "a human should
 * finish this". The pending-identity queue is the closest thing, but it keys
 * entirely off the PRODUCER: a row with a good producer and no region is
 * complete as far as that queue is concerned.
 *
 * REVIEW ONLY, like its siblings — this flags, it never fills. The fix is a
 * human (or the somm's MCP tooling) writing the real value.
 *
 * SELF-CLEARING BY CONSTRUCTION: a row leaves this queue the moment its region
 * is set, so no dismissal is needed for the normal case. The clearance exists
 * for the OTHER case — a wine that legitimately has no region, which is a real
 * category: a country-wide designation (a Vin de France, an "American"
 * bottling) or a multi-region blend has no region to give, and without a
 * clearance those rows would sit in the queue forever. Clearances are stored
 * in `crossChecksCleared`, whose model invariant this check satisfies exactly:
 * its verdict reads nothing but the wine's own region and appellation, both of
 * which the pre-validate hook watches — so filling either one invalidates the
 * clearance automatically, which is the behaviour we want.
 *
 * Rule id is VERSIONED like every other check family: refining what counts as
 * incomplete means bumping the id in the same commit, which invalidates this
 * rule's clearances registry-wide and leaves every other family's work intact.
 */
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');

const GEOGRAPHY_INCOMPLETE_CHECK_ID = 'geography-incomplete.v1';

/**
 * Rows missing their region.
 *
 * Deliberately NOT "missing appellation": a great many wines legitimately
 * carry none (most New World bottlings, everything sold under a country-wide
 * designation), so flagging that would bury the queue in non-problems. A
 * missing REGION is the one that always represents lost information — the
 * statistics map, the region facet and the by-region browse all go blind on
 * it — and it is also the one most often recoverable, because the appellation
 * usually implies it.
 *
 * Quarantined and pending-identity rows are excluded: the first is not part of
 * the registry any more, and the second is already in a queue whose whole
 * purpose is to complete it (adding it here would double-count the same work).
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=50] 0 = count only (the health-job shape: total
 *   is known before any per-row work, so nothing else is computed).
 * @param {number} [opts.offset=0]
 * @param {boolean} [opts.includeCleared=false] the audit view — show rows an
 *   admin marked as legitimately region-less.
 * @returns {Promise<{rows: Array, total: number, scannedCount: number,
 *   clearedCount: number}>} rows sorted most-owned first, each:
 *   { _id, name, producer, appellation, country, bottleCount, hasLead, cleared }
 */
async function incompleteGeographyRows({ limit = 50, offset = 0, includeCleared = false } = {}) {
  const base = {
    nonWine: { $ne: true },
    pendingIdentity: { $ne: true },
    region: null,
  };
  const filter = includeCleared
    ? base
    : { ...base, crossChecksCleared: { $ne: GEOGRAPHY_INCOMPLETE_CHECK_ID } };

  const [total, clearedCount] = await Promise.all([
    WineDefinition.countDocuments(filter),
    WineDefinition.countDocuments({ ...base, crossChecksCleared: GEOGRAPHY_INCOMPLETE_CHECK_ID }),
  ]);
  // The health job wants the number, not the page — and the bottle-count
  // aggregate below is the expensive half.
  if (limit === 0) {
    return { rows: [], total, scannedCount: total, clearedCount };
  }

  // Fetch the candidate set, then rank in memory: the sort key (bottle count)
  // lives in another collection, so no index can serve it and a $lookup over
  // the whole registry costs more than this at ~5.5k rows. The candidate set
  // is the incomplete rows only — a few hundred — not the registry.
  const candidates = await WineDefinition.find(filter)
    .select('name producer appellation country crossChecksCleared createdAt')
    .populate('country', 'name')
    .lean();

  const counts = new Map();
  if (candidates.length > 0) {
    const agg = await Bottle.aggregate([
      { $match: { wineDefinition: { $in: candidates.map((w) => w._id) } } },
      { $group: { _id: '$wineDefinition', n: { $sum: 1 } } },
    ]);
    for (const r of agg) counts.set(String(r._id), r.n);
  }

  const rows = candidates.map((w) => ({
    _id: w._id,
    name: w.name,
    producer: w.producer || null,
    // The appellation is the LEAD: when it names a place, the region usually
    // follows from it directly (and the mint-time canon would already have
    // adopted it if the taxonomy knew that name — so a row here with an
    // appellation is one the taxonomy cannot yet resolve, which is itself
    // useful to see).
    appellation: w.appellation || null,
    country: w.country?.name || null,
    bottleCount: counts.get(String(w._id)) || 0,
    hasLead: !!w.appellation,
    cleared: Array.isArray(w.crossChecksCleared)
      && w.crossChecksCleared.includes(GEOGRAPHY_INCOMPLETE_CHECK_ID),
  }));

  // Impact first: rows real users own outrank empty ones, and within the same
  // ownership an appellation lead (one edit) outranks a blank row (research).
  // createdAt breaks remaining ties so pagination is deterministic.
  rows.sort((a, b) =>
    (b.bottleCount - a.bottleCount) ||
    (Number(b.hasLead) - Number(a.hasLead)) ||
    String(a._id).localeCompare(String(b._id)));

  return {
    rows: rows.slice(offset, offset + limit),
    total,
    scannedCount: candidates.length,
    clearedCount,
  };
}

/**
 * Is this wine still region-less? The server-side re-detect behind the
 * clearance endpoint — a stale client row must not be able to clear a check
 * the admin never actually saw (same stance as /verify-checks and
 * /cross-checks-clear).
 */
async function stillIncomplete(wineIds) {
  const found = await WineDefinition.find({
    _id: { $in: wineIds },
    nonWine: { $ne: true },
    pendingIdentity: { $ne: true },
    region: null,
  }).select('_id').lean();
  return new Set(found.map((w) => String(w._id)));
}

module.exports = {
  incompleteGeographyRows,
  stillIncomplete,
  GEOGRAPHY_INCOMPLETE_CHECK_ID,
};
