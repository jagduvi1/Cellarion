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
const WineReport = require('../models/WineReport');
const WineRequest = require('../models/WineRequest');
const User = require('../models/User');
const RegistryHealthSnapshot = require('../models/RegistryHealthSnapshot');
const { runNameChecks, NAME_CHECK_SELECT } = require('../utils/nameChecks');
const { DEFAULT_CROSS_FIELD_CHECK_IDS } = require('../utils/crossFieldChecks');
const { scanCrossFieldChecks } = require('./crossFieldScan');
const { normalizeString } = require('../utils/normalize');
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
  producerSpellingSplits: 'producer spelling splits',
  missingInvariants: 'rows missing canonicalKey/slug',
  pendingWineReports: 'open wine reports',
  pendingWineRequests: 'pending wine requests',
};
// Per-rule outstanding cross-field counts (ticket 2026-08-10 Tier-2 item 5).
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
  const wines = await WineDefinition.find({ nonWine: { $ne: true } })
    .select(`${NAME_CHECK_SELECT} canonicalKey slug`)
    .lean();

  let nameCheckFlags = 0;
  const spellingsByKey = new Map();
  let missingInvariants = 0;
  for (const w of wines) {
    if (runNameChecks(w)) nameCheckFlags += 1;
    if (!w.canonicalKey || !w.slug) missingInvariants += 1;
    const key = normalizeString(w.producer || '');
    if (key) {
      let set = spellingsByKey.get(key);
      if (!set) { set = new Set(); spellingsByKey.set(key, set); }
      set.add(w.producer);
    }
  }
  let producerSpellingSplits = 0;
  for (const set of spellingsByKey.values()) {
    if (set.size > 1) producerSpellingSplits += 1;
  }

  const [collisionAgg, lowConfidenceQueue, pendingWineReports, pendingWineRequests, crossField] = await Promise.all([
    // Raw collision sets (the admin endpoint additionally hides dismissed
    // sets; dismissals only shrink the number, so an INCREASE here is always
    // a real new collision — which is the only thing this job alerts on).
    WineDefinition.aggregate([
      { $match: { nonWine: { $ne: true }, canonicalKey: { $ne: null } } },
      { $group: { _id: '$canonicalKey', n: { $sum: 1 } } },
      { $match: { n: { $gte: 2 } } },
      { $count: 'sets' },
    ]),
    WineDefinition.countDocuments({
      nonWine: { $ne: true },
      // Mirrors the admin queue in routes/admin/wines.js: a null confidence is
      // an unvouched-for row, not a confident one, and excluding it meant the
      // watchdog could never count the rows most worth counting.
      $or: [
        { 'aiProfile.confidence': null },
        { 'aiProfile.confidence': { $lte: LOW_CONFIDENCE_THRESHOLD } },
      ],
      'aiProfile.generatedAt': { $ne: null },
      $expr: {
        $or: [
          { $eq: ['$profileReviewedAt', null] },
          { $lt: ['$profileReviewedAt', '$aiProfile.generatedAt'] },
        ],
      },
    }),
    WineReport.countDocuments({ status: 'pending' }),
    WineRequest.countDocuments({ status: 'pending' }),
    // Per-rule OUTSTANDING counts (clearance-filtered), mirroring what the
    // admin cross-field queue shows — the same numbers-agree contract as
    // every other metric here. Its own registry pass with its own projection
    // + 4 small taxonomy fetches; same order of work as one admin scan.
    scanCrossFieldChecks(),
  ]);

  const metrics = {
    nameCheckFlags,
    canonicalCollisionSets: collisionAgg[0]?.sets || 0,
    lowConfidenceQueue,
    producerSpellingSplits,
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
