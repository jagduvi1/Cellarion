/**
 * Open-bottle (Coravin / preservation) helpers — backend mirror of
 * frontend/src/utils/openBottle.js (kept in sync by hand, like
 * config/bottleSizes). Freshness windows are rules of thumb per
 * preservation method; the deadline drives the daily expiry alert.
 */

const PRESERVATION_FRESHNESS_DAYS = {
  coravin: 90,
  'inert-gas': 7,
  vacuum: 4,
  'sparkling-stopper': 2,
  recorked: 2,
};

const DEFAULT_FRESHNESS_DAYS = 2;
const DAY_MS = 86400000;

// The valid preservation methods ARE the freshness map's keys — one source for
// the Bottle schema consumers, the REST/MCP validation (bottleOps) and the
// MCP tool input enum.
const PRESERVATION_METHODS = Object.keys(PRESERVATION_FRESHNESS_DAYS);
const DEFAULT_POUR_ML = 125;

/** Drink-by deadline: openedAt + the method's freshness window. Null when unopened. */
function openBottleDeadline(bottle) {
  if (!bottle?.openedAt) return null;
  const days = PRESERVATION_FRESHNESS_DAYS[bottle.preservationMethod] ?? DEFAULT_FRESHNESS_DAYS;
  return new Date(new Date(bottle.openedAt).getTime() + days * DAY_MS);
}

/** Whole days until the deadline (negative = past it). Null when unopened. */
function openBottleDaysLeft(bottle, now = new Date()) {
  const deadline = openBottleDeadline(bottle);
  if (!deadline) return null;
  return Math.ceil((deadline.getTime() - now.getTime()) / DAY_MS);
}

/**
 * Whether the daily notifier should alert for this bottle: open, and on the
 * last day of its freshness window (or already past it). Once-only delivery
 * is the caller's job via the openBottleNotifiedAt marker.
 */
function shouldNotifyOpenBottle(bottle, now = new Date()) {
  const days = openBottleDaysLeft(bottle, now);
  return days !== null && days <= 1;
}

module.exports = {
  PRESERVATION_FRESHNESS_DAYS,
  PRESERVATION_METHODS,
  DEFAULT_POUR_ML,
  openBottleDeadline,
  openBottleDaysLeft,
  shouldNotifyOpenBottle,
};
