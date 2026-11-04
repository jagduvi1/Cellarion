/**
 * Whether this server reviews what its members contribute to the wine
 * registry before it goes live — photos, wine-record fixes, values such as
 * ABV and new data fields. Stored in SiteConfig under 'contributionReview',
 * cached in memory and hot-reloaded on save like the announcement.
 *
 * ON (the default, and cellarion.app): every contribution waits for an admin
 * or curator, because a shared registry shows it to everyone.
 * OFF: a small private server (a household on its own install, discussion
 * #1778) trusts its members, so each contribution is applied as it is made,
 * through the same code an admin's approval runs. A contribution that needs a
 * human choice (a merge, a producer spelled two ways) still waits.
 *
 * This is an install setting, not a feature flag: it changes how
 * contributions are decided, the same for every member of the server.
 */

const defaults = {
  enabled: true,
  updatedAt: null,
};

let cache = { ...defaults };

async function load() {
  try {
    // Lazy require to avoid a circular dependency at module load time.
    const SiteConfig = require('../models/SiteConfig');
    const doc = await SiteConfig.findOne({ key: 'contributionReview' }).lean();
    if (doc && doc.value) {
      cache = {
        enabled: doc.value.enabled !== false,
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      };
    }
  } catch (err) {
    // Unreadable → review stays on: the safe side for a shared registry.
    console.warn('[contributionReview] Could not load config from DB, review stays on:', err.message);
  }
}

function get() {
  return cache;
}

/** True when contributions wait for review (the default). */
function isOn() {
  return cache.enabled !== false;
}

function set(value) {
  cache = { ...defaults, ...value, enabled: value?.enabled !== false };
}

module.exports = { load, get, set, isOn, defaults };
