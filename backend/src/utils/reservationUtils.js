/**
 * Reservation ("spoken for") helpers — ONE definition of what "reserved"
 * means, shared by the drink-suggestion exclusions (drinkingService), the MCP
 * consume guard, the search filters and the notifier. A bottle is reserved
 * iff reservedFor and/or reservedUntil is set; there is deliberately NO
 * status change (Bottle.status stays the active/consumed lifecycle enum).
 */

/** True when the bottle carries a reservation (works on docs and lean objects). */
function isReserved(bottle) {
  if (!bottle) return false;
  const forSet = typeof bottle.reservedFor === 'string' && bottle.reservedFor.trim() !== '';
  const untilSet = bottle.reservedUntil !== null && bottle.reservedUntil !== undefined;
  return forSet || untilSet;
}

/**
 * Human-readable reservation summary for server-side messages (MCP guard
 * text, notifications). Returns '' for an unreserved bottle.
 *   "reserved for Elias's 18th birthday (until 2034)"
 *   "reserved for Elias's 18th birthday"
 *   "reserved until 2034"
 */
function reservationLabel(bottle) {
  if (!isReserved(bottle)) return '';
  const who = typeof bottle.reservedFor === 'string' ? bottle.reservedFor.trim() : '';
  if (who && bottle.reservedUntil != null) return `reserved for ${who} (until ${bottle.reservedUntil})`;
  if (who) return `reserved for ${who}`;
  return `reserved until ${bottle.reservedUntil}`;
}

module.exports = { isReserved, reservationLabel };
