const cron = require('node-cron');
const { runDrinkWindowCheck } = require('./drinkWindowNotifier');
const { runCellarValueSnapshots } = require('./cellarValueSnapshotJob');

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

  console.log('[scheduler] Cron jobs registered (drink-window daily 06:00 UTC, value-snapshot weekly Sun 01:00 UTC)');
}

module.exports = { startScheduler };
