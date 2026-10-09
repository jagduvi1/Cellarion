/**
 * Memory cache for reads that machines poll (services/dataVersion).
 *
 * An entry is answered while the user's data version is the one it was stored
 * at and it is younger than the max age. The version moves on every audited
 * change (and on the explicit bumps the writers make), so an unchanged poll
 * costs no database work; the max age bounds what the version cannot see —
 * expiring rows, jobs, scripts. Read the version BEFORE loading the data, and
 * store the entry with that version: a change landing during the load moves
 * the version on, so the entry can never outlive it.
 *
 * Only for API-token requests (req.apiToken), the way the stats overview and
 * the token bottle list are cached: the Home Assistant integration polls
 * /api/cellars and /api/notifications every few minutes per install, and the
 * integration is on about one active user in four (usage check 2026-10-09),
 * so the polls scale with the users. Browser reads stay uncached.
 *
 * In memory, one Node process — Phase C of the scaling plan moves it to
 * MongoDB with the data version itself.
 */
function createTokenReadCache({ maxEntries = 5000, maxAgeMs = 30 * 60 * 1000 } = {}) {
  const entries = new Map(); // `${userId}|${key}` -> { at, version, body }

  const keyOf = (userId, key) => `${userId}|${key}`;

  /** The stored body, or undefined when there is none or it no longer holds. */
  function get(userId, key, version) {
    const hit = entries.get(keyOf(userId, key));
    if (!hit) return undefined;
    if (hit.version !== version || Date.now() - hit.at >= maxAgeMs) {
      entries.delete(keyOf(userId, key));
      return undefined;
    }
    return hit.body;
  }

  function set(userId, key, version, body) {
    // Same bound as the other read caches: when full, start over. Entries are
    // small (a cellar list, thirty notifications) and refill on the next poll.
    if (entries.size >= maxEntries && !entries.has(keyOf(userId, key))) entries.clear();
    entries.set(keyOf(userId, key), { at: Date.now(), version, body });
  }

  function clear() { entries.clear(); }

  return { get, set, clear, get size() { return entries.size; } };
}

module.exports = { createTokenReadCache };
