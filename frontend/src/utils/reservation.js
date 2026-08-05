/**
 * Reservation ("spoken for") helpers — one definition of "reserved" for every
 * surface that renders it (BottleCard badge, bottle detail, rack views, the
 * consume confirm). Mirrors backend utils/reservationUtils.js: a bottle is
 * reserved iff reservedFor and/or reservedUntil (a calendar year) is set.
 */

/** True when the bottle carries a reservation. */
export function isReserved(bottle) {
  if (!bottle) return false;
  const forSet = typeof bottle.reservedFor === 'string' && bottle.reservedFor.trim() !== '';
  const untilSet = bottle.reservedUntil !== null && bottle.reservedUntil !== undefined;
  return forSet || untilSet;
}

/**
 * Translated one-line summary of the reservation, or '' when unreserved.
 * Keys live under bottleDetail.reserved* in the en bundle.
 */
export function reservationSummary(bottle, t) {
  if (!isReserved(bottle)) return '';
  const who = typeof bottle.reservedFor === 'string' ? bottle.reservedFor.trim() : '';
  const until = bottle.reservedUntil ?? null;
  if (who && until != null) return t('bottleDetail.reservedForUntil', { who, year: until });
  if (who) return t('bottleDetail.reservedForOnly', { who });
  return t('bottleDetail.reservedUntilOnly', { year: until });
}
