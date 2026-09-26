/**
 * Per-user "wine data changed" version, for read caches.
 *
 * logAudit bumps it on every bottle./cellar. mutation — for the acting user and
 * the cellar's owner, the same funnel and recipients as the MCP cache busts and
 * the stats_changed push. A cache stores the version it read BEFORE loading its
 * data; while getDataVersion() still returns that number, nothing it read has
 * changed through the app, so it can answer from memory. A change landing while
 * it computes moves the version on, so a stale answer never outlives the change.
 *
 * Why (scaling audit 2026-09-25): Home Assistant polls the stats overview and
 * the maturity list every few minutes, and every poll recomputed the user's
 * whole collection — the #1 database load.
 *
 * In memory, like the MCP caches and the event bus: one Node process. A second
 * API process (scaling plan Phase C) moves this to MongoDB with the rest.
 * Changes that bypass logAudit — registry edits, curated drink windows, jobs,
 * scripts — are not seen here; every cache also caps its age.
 */

// One global clock: every bump takes the next tick. A user never bumped reads
// `floor`. To bound memory the map is dropped and `floor` raised to the clock —
// every user then reads a number at least as new as any version handed out
// before, so an entry cached earlier can only still match if nothing changed.
const versions = new Map(); // userId -> tick of their last change
const MAX_USERS = 50000;
let clock = 0;
let floor = 0;

function bumpDataVersion(userId) {
  if (!userId) return;
  const key = String(userId);
  if (versions.size >= MAX_USERS && !versions.has(key)) {
    floor = clock;
    versions.clear();
  }
  clock += 1;
  versions.set(key, clock);
}

function getDataVersion(userId) {
  return versions.get(String(userId)) ?? floor;
}

module.exports = { bumpDataVersion, getDataVersion };
