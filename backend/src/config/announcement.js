/**
 * Site announcement banner — SuperAdmin-managed message shown to all users
 * (e.g. "Maintenance tonight 22:00–22:15"). Stored in SiteConfig under
 * 'announcement', cached in memory and hot-reloaded on save like rateLimits.
 *
 * `updatedAt` doubles as the dismissal version: the frontend remembers which
 * version a user dismissed, so editing the message re-shows the banner.
 */

const defaults = {
  enabled: false,
  message: '',
  messageSv: '', // optional Swedish text; falls back to message
  type: 'info', // info | warning
  updatedAt: null,
};

let cache = { ...defaults };

async function load() {
  try {
    // Lazy require to avoid circular dependency at module load time
    const SiteConfig = require('../models/SiteConfig');
    const doc = await SiteConfig.findOne({ key: 'announcement' });
    if (doc && doc.value) {
      cache = {
        enabled: doc.value.enabled ?? defaults.enabled,
        message: doc.value.message ?? defaults.message,
        messageSv: doc.value.messageSv ?? defaults.messageSv,
        type: ['info', 'warning'].includes(doc.value.type) ? doc.value.type : defaults.type,
        updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
      };
    }
  } catch (err) {
    console.warn('[announcement] Could not load config from DB, using defaults:', err.message);
  }
}

function get() {
  return cache;
}

function set(value) {
  cache = { ...defaults, ...value };
}

module.exports = { load, get, set, defaults };
