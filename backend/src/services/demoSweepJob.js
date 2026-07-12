/**
 * Ephemeral demo sweep — runs every ~15 min via the scheduler.
 *
 * Finds demo accounts whose lifetime (demoExpiresAt) has passed and fully erases
 * them: the user row AND every cloned document (bottles/racks/cellars/layout/
 * journal/on-disk images/Meilisearch docs) via the SAME registry-driven cascade
 * used for real account deletion (services/userDataRegistry.purgeUserData), so
 * demo cleanup can never drift from that source of truth.
 *
 * Why a cron sweep rather than a Mongo TTL index: a TTL index would delete only
 * the User row and orphan all cloned data — the exact DB-bloat outcome we're
 * avoiding. purgeUserData (application code) is mandatory for the cascade.
 */
const User = require('../models/User');
const { purgeUserData } = require('./userDataRegistry');
const eventBus = require('./eventBus');

// Cap one sweep pass so an abusive burst of demos can't make a single run do
// unbounded work; the next tick (~15 min later) picks up any remainder.
const SWEEP_BATCH = 500;

async function runDemoSweep() {
  const now = new Date();

  const expired = await User.find({
    isDemo: true,
    demoExpiresAt: { $lte: now },
  }).select('_id email').limit(SWEEP_BATCH).lean();

  if (expired.length === 0) return { deleted: 0 };

  let deleted = 0;
  for (const user of expired) {
    try {
      // Close any live SSE stream first so it doesn't dangle once the row is
      // gone (mirrors the account-deletion path); /refresh then 401s cleanly.
      eventBus.dropUser(user._id);
      await purgeUserData(user._id, user.email);
      await User.deleteOne({ _id: user._id });
      deleted++;
    } catch (err) {
      // Demo data is not real PII; a per-user failure is logged in aggregate and
      // retried next tick rather than emitting per-user audit/log churn.
      console.error(`[demo-sweep] Failed to purge demo user ${user._id}:`, err.message);
    }
  }

  return { deleted };
}

module.exports = { runDemoSweep };
