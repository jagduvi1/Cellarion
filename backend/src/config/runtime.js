/**
 * The settings an admin changes at run time — rate limits, AI settings, the
 * announcement banner and the feature flags — live in SiteConfig and are
 * cached in memory by their config modules. server.js calls
 * loadRuntimeConfig() once the database is connected and before the boot
 * migrations, the scheduler and app.listen, so nothing reads a cache before
 * the stored settings are in it.
 *
 * Never rejects: a config that cannot be read keeps its code defaults (each
 * load() already falls back on its own; this is the backstop) and the
 * server starts anyway.
 */

const rateLimits = require('./rateLimits');
const aiConfig = require('./aiConfig');
const announcement = require('./announcement');
const featureFlags = require('./featureFlags');

const CONFIGS = [
  ['rateLimits', rateLimits],
  ['aiConfig', aiConfig],
  ['announcement', announcement],
  ['featureFlags', featureFlags],
];

async function loadRuntimeConfig() {
  const results = await Promise.allSettled(CONFIGS.map(async ([, config]) => config.load()));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`[${CONFIGS[i][0]}] Startup load failed, using defaults:`, result.reason?.message ?? result.reason);
    }
  });
}

module.exports = { loadRuntimeConfig };
