const WineRequest = require('../models/WineRequest');

/**
 * Import-time wine requests, shared by routes/import.js and
 * services/cellarImport.js.
 *
 * Two lessons from the 2026-09-05 CellarTracker import (support ticket
 * 2026-09-05, 243 requests / 642 bottles in one run):
 *
 *   1. A request must be REUSED across imports. The per-run cache only
 *      deduplicated within one file, so a user who re-imports (a cleaned-up
 *      export, a second cellar) minted a second pending request for every
 *      wine still waiting — and the admin queue doubled.
 *   2. A request must CARRY what the file said about the wine. CellarTracker,
 *      Vivino and Ploc exports all name the country, region, appellation and
 *      type; dropping them left the curator to re-derive 243 geographies by
 *      hand. They ride along as `hints` — plain strings, never written to the
 *      registry until an admin resolves the request.
 */

const HINT_LIMITS = { country: 100, region: 100, appellation: 150, type: 20 };

function cleanHint(value, max) {
  if (value == null) return '';
  const s = String(value).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** The hint fields an import row may carry; null when the row has none. */
function pickImportHints(item) {
  if (!item || typeof item !== 'object') return null;
  const hints = {};
  for (const [key, max] of Object.entries(HINT_LIMITS)) {
    const v = cleanHint(item[key], max);
    if (v) hints[key] = key === 'type' ? v.toLowerCase() : v;
  }
  return Object.keys(hints).length ? hints : null;
}

function hasHints(doc) {
  const h = doc && doc.hints;
  return !!(h && (h.country || h.region || h.appellation || h.type));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find the user's existing PENDING new_wine request for this wine and
 * producer (case-insensitive, exact after trimming), or create one.
 *
 * @param {object} args
 * @param {string|ObjectId} args.userId
 * @param {string} args.wineName
 * @param {string} [args.producer]
 * @param {string[]} [args.suggestedGrapes]
 * @param {object|null} [args.hints]     from pickImportHints(item)
 * @param {Map} [args.cache]             per-run cache keyed on name|producer
 * @returns {Promise<{ wineRequest: object, reused: boolean }>}
 */
async function findOrCreatePendingRequest({ userId, wineName, producer, suggestedGrapes = [], hints = null, cache = null }) {
  const name = String(wineName || '').trim();
  const prod = String(producer || '').trim();
  const key = `${name.toLowerCase()}|${prod.toLowerCase()}`;
  if (cache && cache.has(key)) return { wineRequest: cache.get(key), reused: true };

  const filter = {
    user: userId,
    requestType: 'new_wine',
    status: 'pending',
    wineName: new RegExp('^' + escapeRegex(name) + '$', 'i'),
    producer: prod ? new RegExp('^' + escapeRegex(prod) + '$', 'i') : { $in: [null, ''] },
  };
  let wineRequest = await WineRequest.findOne(filter);
  const reused = !!wineRequest;

  if (!wineRequest) {
    wineRequest = new WineRequest({
      requestType: 'new_wine',
      wineName: name,
      producer: prod || undefined,
      user: userId,
      status: 'pending',
      ...(suggestedGrapes.length > 0 ? { suggestedGrapes } : {}),
      ...(hints ? { hints } : {}),
    });
    await wineRequest.save();
  } else if (hints && !hasHints(wineRequest)) {
    // An older request without hints learns them from this file.
    wineRequest.hints = hints;
    await wineRequest.save();
  }

  if (cache) cache.set(key, wineRequest);
  return { wineRequest, reused };
}

module.exports = { findOrCreatePendingRequest, pickImportHints, hasHints, HINT_LIMITS };
