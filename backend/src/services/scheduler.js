const cron = require('node-cron');
const { runDrinkWindowCheck } = require('./drinkWindowNotifier');
const { runCellarValueSnapshots } = require('./cellarValueSnapshotJob');
const { runCommunityPriceAggregation } = require('./communityPriceJob');
const { runUserDeletionJob } = require('./userDeletionJob');
const { runCellarRetentionPurge } = require('./cellarRetentionJob');
const { runRecommendationEmailScrub } = require('./recommendationRetentionJob');
const { runSecurityAlertCheck } = require('./securityAlertJob');
const { runClimateOfflineCheck } = require('./climateOfflineJob');
const { runDemoSweep } = require('./demoSweepJob');
const { runRegistryHealthCheck } = require('./registryHealthJob');
const embeddingJob = require('./embeddingJob');

/**
 * Start all scheduled cron jobs.
 * Call once from server.js after DB connection is established.
 */
function startScheduler() {
  // Drink window check: daily at 06:00 UTC
  cron.schedule('0 6 * * *', async () => {
    console.log('[scheduler] Running drink window check…');
    try {
      await runDrinkWindowCheck();
    } catch (err) {
      console.error('[scheduler] Drink window check failed:', err);
    }
  });

  // Cellar value snapshots: weekly on Sunday at 01:00 UTC
  cron.schedule('0 1 * * 0', async () => {
    console.log('[scheduler] Running cellar value snapshots…');
    try {
      await runCellarValueSnapshots();
    } catch (err) {
      console.error('[scheduler] Cellar value snapshot failed:', err);
    }
  });

  // Community release-price aggregation: weekly on Sunday at 02:00 UTC
  // (after the value snapshots). Cheap; release prices are stable.
  cron.schedule('0 2 * * 0', async () => {
    console.log('[scheduler] Running community price aggregation…');
    try {
      await runCommunityPriceAggregation();
    } catch (err) {
      console.error('[scheduler] Community price aggregation failed:', err);
    }
  });

  // User account deletion: daily at 03:00 UTC (after 7-day cooling-off)
  cron.schedule('0 3 * * *', async () => {
    console.log('[scheduler] Running user deletion job…');
    try {
      await runUserDeletionJob();
    } catch (err) {
      console.error('[scheduler] User deletion job failed:', err);
    }
  });

  // Cellar/rack retention purge: daily at 04:00 UTC (after user deletion).
  // Hard-deletes soft-deleted cellars/racks past the promised 30-day window.
  cron.schedule('0 4 * * *', async () => {
    console.log('[scheduler] Running cellar retention purge…');
    try {
      await runCellarRetentionPurge();
    } catch (err) {
      console.error('[scheduler] Cellar retention purge failed:', err);
    }
  });

  // External recipient-email retention scrub: daily at 04:30 UTC (after the
  // cellar retention purge). Blanks Recommendation.recipientEmail on documents
  // older than 90 days — third-party PII with no account-based erasure path.
  cron.schedule('30 4 * * *', async () => {
    console.log('[scheduler] Running recommendation email retention scrub…');
    try {
      await runRecommendationEmailScrub();
    } catch (err) {
      console.error('[scheduler] Recommendation email scrub failed:', err);
    }
  });

  // Security spike check: every 15 minutes. Cheap audit-log query, emails
  // only when thresholds are crossed (with 4h cooldown per spike type).
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await runSecurityAlertCheck();
      if (result?.sent) console.log('[scheduler] Security alert sent:', result.triggers);
    } catch (err) {
      console.error('[scheduler] Security alert check failed:', err);
    }
  });

  // Climate sensor offline detection: every 15 minutes. Cheap indexed query
  // over devices that have posted before; one notification per silence
  // (recovery is handled by the ingest route when the device returns).
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await runClimateOfflineCheck();
      if (result?.notified > 0) console.log('[scheduler] Climate offline notifications sent:', result.notified);
    } catch (err) {
      console.error('[scheduler] Climate offline check failed:', err);
    }
  });

  // Ephemeral demo sweep: every 15 minutes, offset (5,20,35,50) so it doesn't
  // pile onto the two */15 jobs above. Fully erases expired demo accounts + all
  // cloned data via the purgeUserData cascade. A short cadence keeps dead demo
  // data (and the global-ceiling headroom) from accumulating between the hourly-
  // scale TTLs. Cheap: a partial-indexed query over only demo rows.
  cron.schedule('5,20,35,50 * * * *', async () => {
    try {
      const result = await runDemoSweep();
      if (result?.deleted > 0) console.log('[scheduler] Demo sweep deleted', result.deleted, 'expired demo account(s)');
    } catch (err) {
      console.error('[scheduler] Demo sweep failed:', err);
    }
  });

  // Registry health: weekly on Monday at 05:00 UTC (quiet slot — Sunday has
  // the value/price jobs, 06:00 has drink-window). Read-only counts over the
  // registry's detection nets; notifies admins only when a metric regresses
  // against the previous run (strategy 2026-07-29 R6 — every net existed but
  // nothing ran them on a schedule).
  cron.schedule('0 5 * * 1', async () => {
    console.log('[scheduler] Running registry health check…');
    try {
      await runRegistryHealthCheck();
    } catch (err) {
      console.error('[scheduler] Registry health check failed:', err);
    }
  });

  // Incremental embedding catch-all: weekly on Monday at 05:30 UTC (after the
  // registry health check). Curation writes re-embed inline, but this sweeps
  // up anything that slipped (a failed inline call, a script-driven change) —
  // textHash-keyed, so an up-to-date registry makes this a near-no-op.
  // "Already running" is fine, not an error: someone started a manual run.
  cron.schedule('30 5 * * 1', async () => {
    console.log('[scheduler] Running weekly incremental embedding sweep…');
    try {
      await embeddingJob.start({ mode: 'incremental' });
    } catch (err) {
      if (/already running/i.test(err.message)) {
        console.log('[scheduler] Embedding job already running — sweep skipped');
      } else {
        console.error('[scheduler] Weekly embedding sweep failed:', err.message);
      }
    }
  });

  console.log('[scheduler] Cron jobs registered (drink-window daily 06:00 UTC, value-snapshot weekly Sun 01:00 UTC, community-price weekly Sun 02:00 UTC, user-deletion daily 03:00 UTC, cellar-retention daily 04:00 UTC, recommendation-email-scrub daily 04:30 UTC, security-spike every 15 min, climate-offline every 15 min, demo-sweep every 15 min offset, registry-health weekly Mon 05:00 UTC, embed-sweep weekly Mon 05:30 UTC)');
}

module.exports = { startScheduler };
