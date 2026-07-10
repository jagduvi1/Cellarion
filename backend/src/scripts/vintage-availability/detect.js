'use strict';

/**
 * Core detection logic — provider-agnostic.
 *
 * The real feature stores, per watched wine, the set of vintages last seen as
 * "available" on each source. On each run we fetch the current available set and
 * diff it: any vintage that is available now but was NOT in the stored set is a
 * NEW RELEASE -> notify the watchers. This module is the pure function that does
 * the diff, so it can be unit-tested without any network.
 */

/**
 * @param {number[]} previousVintages  vintages seen available on the last run
 * @param {number[]} currentVintages   vintages available now (from a provider)
 * @param {object} [opts]
 * @param {number} [opts.wantedVintage] a specific vintage the user is waiting for
 * @returns {{newlyAvailable:number[], wantedNowAvailable:boolean, currentVintages:number[]}}
 */
function diffAvailability(previousVintages, currentVintages, opts = {}) {
  const prev = new Set((previousVintages || []).map(Number));
  const curr = [...new Set((currentVintages || []).map(Number))].sort((a, b) => a - b);
  const newlyAvailable = curr.filter((v) => !prev.has(v));
  const wanted = opts.wantedVintage != null ? Number(opts.wantedVintage) : null;
  return {
    currentVintages: curr,
    newlyAvailable,
    wantedNowAvailable: wanted != null ? curr.includes(wanted) : false,
  };
}

/**
 * Merge availability results from several providers into one view for a wine.
 * @param {Array<{source:string, availableVintages:number[], ok:boolean}>} results
 */
function mergeSources(results) {
  const union = new Set();
  const bySource = {};
  for (const r of results || []) {
    bySource[r.source] = r.ok ? r.availableVintages : null;
    if (r.ok) for (const v of r.availableVintages || []) union.add(Number(v));
  }
  return {
    unionAvailableVintages: [...union].sort((a, b) => a - b),
    bySource,
  };
}

module.exports = { diffAvailability, mergeSources };
