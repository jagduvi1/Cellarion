/**
 * How this server treats the wines a cellar-file import brings in. Stored in
 * SiteConfig under 'importPolicy', cached in memory and hot-reloaded on save
 * like the other run-time settings (config/runtime.js).
 *
 * aiLookup (default on): a row the registry does not know is sent to the AI
 * provider to be identified, when one is configured. OFF: no row of an import
 * goes to an AI provider; a row the registry does not know becomes a wine
 * from what the file itself states.
 *
 * checkNewWines (default off): a wine an import creates waits for a curator's
 * check before anyone but its owner sees it
 * (models/WineDefinition.uncheckedIdentity). It only applies while this server
 * reviews contributions at all (config/contributionReview): a private server
 * that trusts its members has nobody working that queue, so its imported
 * wines are published as they are created, whatever this says.
 *
 * Install settings, not feature flags: both change what is stored, the same
 * for every member of the server.
 */
const contributionReview = require('./contributionReview');

const defaults = {
  aiLookup: true,
  checkNewWines: false,
  updatedAt: null,
};

let cache = { ...defaults };

const clean = (value) => ({
  aiLookup: value?.aiLookup !== false,
  checkNewWines: value?.checkNewWines === true,
});

async function load() {
  try {
    // Lazy require to avoid a circular dependency at module load time.
    const SiteConfig = require('../models/SiteConfig');
    const doc = await SiteConfig.findOne({ key: 'importPolicy' }).lean();
    if (doc && doc.value) {
      cache = { ...clean(doc.value), updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null };
    }
  } catch (err) {
    console.warn('[importPolicy] Could not load config from DB, using defaults:', err.message);
  }
}

function get() {
  return cache;
}

function set(value) {
  cache = { ...clean(value), updatedAt: value?.updatedAt || null };
}

/** True when an import may send rows to the AI provider (the default). */
function usesAi() {
  return cache.aiLookup !== false;
}

/** True when a wine an import creates waits for a curator's check. */
function checksNewWines() {
  return cache.checkNewWines === true && contributionReview.isOn();
}

module.exports = { load, get, set, usesAi, checksNewWines, defaults };
