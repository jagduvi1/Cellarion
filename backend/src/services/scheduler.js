const cron = require('node-cron');
const { runDrinkWindowCheck } = require('./drinkWindowNotifier');
const { runCellarValueSnapshots } = require('./cellarValueSnapshotJob');
const { runCommunityPriceAggregation } = require('./communityPriceJob');
const { runUserDeletionJob } = require('./userDeletionJob');
const { runCellarRetentionPurge } = require('./cellarRetentionJob');
const { runRecommendationEmailScrub } = require('./recommendationRetentionJob');
const { runSecurityAlertCheck } = require('./securityAlertJob');

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

  console.log('[scheduler] Cron jobs registered (drink-window daily 06:00 UTC, value-snapshot weekly Sun 01:00 UTC, community-price weekly Sun 02:00 UTC, user-deletion daily 03:00 UTC, cellar-retention daily 04:00 UTC, recommendation-email-scrub daily 04:30 UTC, security-spike every 15 min)');
}

module.exports = { startScheduler };
