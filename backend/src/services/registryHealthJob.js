/**
 * Weekly registry-health check (registry strategy 2026-07-29, R6).
 *
 * Every detection net the registry has — name checks, canonical collisions,
 * the low-confidence queue, producer spelling splits, invariant drift — was
 * manual before this: a human had to remember to press a button or run a
 * container command, and the 2026-07 audits repeatedly found month-old
 * regressions nobody had looked for. This job runs the cheap read-only counts
 * on a schedule and notifies every admin when a metric REGRESSES against the
 * previous run (alert-on-increase + re-baseline — the same pattern as the
 * prod registry watchdog, so a standing backlog alerts once, not weekly).
 *
 * Deliberately counts, not findings: the queues themselves are the workbench
 * (AdminWines), this is only the doorbell. Every metric here mirrors an
 * existing admin surface's own query so the numbers agree with what the admin
 * sees when they click through.
 */
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const WineReport = require('../models/WineReport');
const WineRequest = require('../models/WineRequest');
const User = require('../models/User');
const RegistryHealthSnapshot = require('../models/RegistryHealthSnapshot');
const { runNameChecks, NAME_CHECK_SELECT } = require('../utils/nameChecks');
const { DEFAULT_CROSS_FIELD_CHECK_IDS } = require('../utils/crossFieldChecks');
const { OUTSTANDING_REVIEW_EXPR } = require('../utils/profileReview');
const { scanCrossFieldChecks } = require('./crossFieldScan');
const { nearProducerPairs, nameSubsetPairs } = require('./registryFragmentation');
const { incompleteGeographyRows } = require('./registryCompleteness');
const { isIdentitySentinel } = require('../utils/normalize');
const { producerSegment } = require('../utils/wineIdentity');
const { createNotification } = require('./notifications');

// Mirrors the admin low-confidence queue's default (routes/admin/wines.js).
const LOW_CONFIDENCE_THRESHOLD = 0.3;

// Cross-field rule ids become snapshot metric keys. Two constraints shape the
// fold: Mongoose Map keys (RegistryHealthSnapshot.metrics) may not contain
// '.', and rule ids end in a versioned '.vN' — so the dot folds to '_', and a
// rule-id bump therefore lands as a NEW metric key, which is exactly right:
// the bumped rule's count restarts against a fresh baseline instead of
// diffing v2's queue against v1's.
const crossFieldMetricKey = (ruleId) => `crossField_${ruleId.replace(/\./g, '_')}`;

/** Human labels for the notification message — keys match computeMetrics. */
const METRIC_LABELS = {
  nameCheckFlags: 'name-check flags',
  canonicalCollisionSets: 'canonical-key collision sets',
  lowConfidenceQueue: 'low-confidence profiles',
  // Replaced producerSpellingSplits (2026-08-14): the old metric grouped by
  // normalizeString, which does NOT fold estate titles — so all 130
  // "Philipp Kuhn" / "Weingut Philipp Kuhn" display splits counted ZERO and
  // the watchdog never rang. The new key groups by producerSegment + country
  // (decoration-aware, cross-country fenced). A NEW key on purpose, per the
  // crossFieldMetricKey rule above: the count restarts against a fresh
  // baseline instead of diffing the new definition against the old one.
  producerDisplaySplits: 'producer display splits (same estate, several spellings)',
  // The TYPO complement of the display-split metric: producer keys within a
  // small edit distance inside one (country, appellation) bucket — "Philip
  // Kuhn" beside "Philipp Kuhn", both Pfalz. Mint-time adoption deliberately
  // refuses these (a 1-edit pair can be two real estates: Rockford/Rochford),
  // so they land in the admin fragmentation queue — which nobody opens
  // unprompted. Counting the queue here gives typo splits the same
  // once-per-regression bell as every other net.
  nearProducerPairs: 'near-miss producer pairs (possible typo splits)',
  // Short-vs-full name fragments within ONE producer ("Vat 8" beside "Vat 8
  // Shiraz Cabernet" — an import can mint such pairs that no other detector
  // fires on; the same-producer+appellation group buries them inside the
  // estate's whole range). Counts the admin
  // name-subsets fragmentation queue via the same function, so the number and
  // the queue agree.
  nameSubsetPairs: 'short-vs-full name fragment pairs (one producer)',
  // Rows that are not wrong, just BLANK — no region at all. Every other net
  // keys off a value, so these trip nothing and sit invisible (180 on prod
  // the day the queue shipped, 112 owned by real users). Counts the admin
  // completeness queue via the same function, so number and queue agree.
  incompleteGeography: 'published rows with no region',
  // The v1.116.0 review-queue class: producerSuspect rows surface in the
  // admin queue regardless of confidence threshold, and held profiles live
  // here. A NEW key rather than a redefinition of lowConfidenceQueue — same
  // fresh-baseline rule as producerDisplaySplits above, so the watchdog
  // diffs this class against its own baseline instead of ringing once for a
  // definition change.
  producerSuspectProfiles: 'producer-suspect profiles awaiting review',
  // The publication gate's output: generated
  // but HELD rows awaiting a release decision in the admin queue. Its own
  // key, per the fresh-baseline rule above; lowConfidenceQueue now counts
  // PUBLISHED rows only — holds leaving it can only shrink that number,
  // which never alerts.
  heldProfiles: 'held profiles awaiting release (publication gate)',
  // The curated core (rethink decision 3, 2026-08-18): wines ≥3 distinct
  // owners must reach curator-verified profiles; this counts the ones that
  // haven't. Mirrors the somm's list_unverified_core_wines worklist, same
  // numbers-agree contract as every metric here.
  coreUnverifiedProfiles: 'core wines (≥3 owners) without a curator-verified profile',
  missingInvariants: 'rows missing canonicalKey/slug',
  pendingWineReports: 'open wine reports',
  pendingWineRequests: 'pending wine requests',
};
// Per-rule outstanding cross-field counts (services/crossFieldScan).
// Registered per rule, not as one lump sum, so the alert names WHICH kind of
// misplacement regressed. New keys have no baseline on their first run — the
// job skips them for one cycle (see the `before` guard below), and the prod
// watchdog script prints each as NEW METRIC once; both are expected and fine.
for (const id of DEFAULT_CROSS_FIELD_CHECK_IDS) {
  METRIC_LABELS[crossFieldMetricKey(id)] = `cross-field flags (${id})`;
}

async function computeMetrics() {
  // One lean pass serves both the name checks and the spelling-split count —
  // ~4k rows of three short fields, the same order of work as one admin scan.
  const wines = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
    .select(`${NAME_CHECK_SELECT} country canonicalKey slug`)
    .lean();

  let nameCheckFlags = 0;
  const spellingsByKey = new Map();
  let missingInvariants = 0;
  for (const w of wines) {
    if (runNameChecks(w)) nameCheckFlags += 1;
    if (!w.canonicalKey || !w.slug) missingInvariants += 1;
    // Display-split buckets: producer COMPARISON key + country. The key folds
    // titles/legal suffixes ("Philipp Kuhn" ≡ "Weingut Philipp Kuhn" ≡
    // "… GmbH"), which is the class the old normalizeString grouping was
    // blind to; the country fence keeps "Taylors" (AU) vs "Taylor's" (PT) —
    // different estates — from counting as a split. Sentinels excluded: ten
    // flavours of "Unknown" are a data gap, not a spelling split.
    if (w.producer && !isIdentitySentinel(w.producer)) {
      const seg = producerSegment(w.producer);
      if (seg) {
        const key = `${seg}\u0000${w.country || ''}`;
        let set = spellingsByKey.get(key);
        if (!set) { set = new Set(); spellingsByKey.set(key, set); }
        set.add(String(w.producer).trim().replace(/\s+/g, ' '));
      }
    }
  }
  let producerDisplaySplits = 0;
  for (const set of spellingsByKey.values()) {
    if (set.size > 1) producerDisplaySplits += 1;
  }

  const [collisionAgg, lowConfidenceQueue, producerSuspectProfiles, heldProfiles, coreOwnership, pendingWineReports, pendingWineRequests, crossField, nearMiss, nameSubsets, incompleteGeo] = await Promise.all([
    // Raw collision sets (the admin endpoint additionally hides dismissed
    // sets; dismissals only shrink the number, so an INCREASE here is always
    // a real new collision — which is the only thing this job alerts on).
    WineDefinition.aggregate([
      { $match: { nonWine: { $ne: true }, pendingIdentity: { $ne: true }, canonicalKey: { $ne: null } } },
      { $group: { _id: '$canonicalKey', n: { $sum: 1 } } },
      { $match: { n: { $gte: 2 } } },
      { $count: 'sets' },
    ]),
    WineDefinition.countDocuments({
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      // Mirrors the admin queue in routes/admin/wines.js: a null confidence is
      // an unvouched-for row, not a confident one, and excluding it meant the
      // watchdog could never count the rows most worth counting. The queue's
      // producerSuspect branch is deliberately NOT here — that class counts
      // under its own key (producerSuspectProfiles) so this metric keeps its
      // baseline. Held rows are excluded the same way since the publication
      // gate (2026-08-18): they count under heldProfiles, and this metric
      // becomes what its label says — low-confidence profiles users can SEE.
      // Post-gate it should trend toward zero; excluding holds only shrinks
      // it, which never alerts.
      'aiProfile.heldAt': null,
      $or: [
        { 'aiProfile.confidence': null },
        { 'aiProfile.confidence': { $lte: LOW_CONFIDENCE_THRESHOLD } },
      ],
      'aiProfile.generatedAt': { $ne: null },
      $expr: OUTSTANDING_REVIEW_EXPR,
    }),
    // The suspect class the admin queue shows regardless of threshold
    // (v1.116.0) — outstanding-filtered the same way, so queue and metric
    // agree.
    WineDefinition.countDocuments({
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      'aiProfile.producerSuspect': true,
      'aiProfile.generatedAt': { $ne: null },
      $expr: OUTSTANDING_REVIEW_EXPR,
    }),
    // Held rows awaiting a release decision — outstanding-filtered like the
    // suspect metric, so the count agrees with what the admin queue shows.
    WineDefinition.countDocuments({
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      'aiProfile.heldAt': { $ne: null },
      'aiProfile.generatedAt': { $ne: null },
      $expr: OUTSTANDING_REVIEW_EXPR,
    }),
    // Core ownership sets (≥3 distinct owners of active bottles) — the wine
    // filter happens after the join below; one Bottle aggregate, the job's
    // standard unit of cost.
    Bottle.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$wineDefinition', owners: { $addToSet: '$user' } } },
      { $project: { ownerCount: { $size: '$owners' } } },
      { $match: { ownerCount: { $gte: 3 } } },
    ]),
    WineReport.countDocuments({ status: 'pending' }),
    WineRequest.countDocuments({ status: 'pending' }),
    // Per-rule OUTSTANDING counts (clearance-filtered), mirroring what the
    // admin cross-field queue shows — the same numbers-agree contract as
    // every other metric here. Its own registry pass with its own projection
    // + 4 small taxonomy fetches; same order of work as one admin scan.
    scanCrossFieldChecks(),
    // Typo-distance producer pairs — the SAME function the admin
    // fragmentation queue calls, so the count and the queue agree. limit: 0
    // keeps the page empty (only `total` is wanted); the scan itself is one
    // more small-projection registry fetch, the job's standard unit of cost.
    nearProducerPairs({ limit: 0 }),
    // Same function as the admin name-subsets queue; only `total` is wanted.
    nameSubsetPairs({ limit: 0 }),
    // Count only — limit 0 skips the per-row bottle aggregate.
    incompleteGeographyRows({ limit: 0 }),
  ]);

  const coreUnverifiedProfiles = coreOwnership.length === 0 ? 0
    : await WineDefinition.countDocuments({
      _id: { $in: coreOwnership.map((o) => o._id) },
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      'aiProfile.source': { $ne: 'curator' },
    });

  const metrics = {
    nameCheckFlags,
    canonicalCollisionSets: collisionAgg[0]?.sets || 0,
    lowConfidenceQueue,
    producerSuspectProfiles,
    heldProfiles,
    coreUnverifiedProfiles,
    producerDisplaySplits,
    nearProducerPairs: nearMiss.total,
    nameSubsetPairs: nameSubsets.total,
    incompleteGeography: incompleteGeo.total,
    missingInvariants,
    pendingWineReports,
    pendingWineRequests,
  };
  for (const [ruleId, count] of Object.entries(crossField.ruleCounts)) {
    metrics[crossFieldMetricKey(ruleId)] = count;
  }
  return metrics;
}

/**
 * @returns {Promise<{metrics: object, regressions: string[], notified: number, baseline: boolean}>}
 */
async function runRegistryHealthCheck() {
  const metrics = await computeMetrics();
  const previous = await RegistryHealthSnapshot.findOne().sort({ createdAt: -1 }).lean();

  const regressions = [];
  if (previous) {
    // .lean() always yields the Map field as a plain object (Mongoose only
    // hydrates SchemaMap on document init, never on lean queries).
    const prev = previous.metrics || {};
    for (const [key, label] of Object.entries(METRIC_LABELS)) {
      const before = prev[key];
      // A metric added after the baseline was written has no `before` — skip
      // one cycle rather than alerting on the difference from undefined.
      if (typeof before !== 'number') continue;
      if (metrics[key] > before) regressions.push(`${label}: ${before} → ${metrics[key]}`);
    }
  }

  // Always write the new baseline — including on a regression, so each alert
  // fires once and the next run measures from here (alert-once + re-baseline).
  await RegistryHealthSnapshot.create({ metrics });

  let notified = 0;
  if (regressions.length > 0) {
    const admins = await User.find({ roles: 'admin' }).select('_id').lean();
    const message = `Weekly registry check found regressions since last run — ${regressions.join('; ')}.`;
    for (const admin of admins) {
      try {
        await createNotification(
          admin._id,
          'registry_health',
          'Registry health: something regressed',
          message,
          '/admin/wines'
        );
        notified += 1;
      } catch (err) {
        console.warn('[registryHealth] notify failed (non-fatal):', err.message);
      }
    }
  }

  console.log(`[registryHealth] ${JSON.stringify(metrics)} regressions=${regressions.length} notified=${notified}`);
  return { metrics, regressions, notified, baseline: !previous };
}

module.exports = { runRegistryHealthCheck, computeMetrics, METRIC_LABELS, crossFieldMetricKey };
