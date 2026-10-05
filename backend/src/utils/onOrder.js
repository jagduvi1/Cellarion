/**
 * Bottles on order: bought, not delivered yet (en primeur, a pre-order, a
 * delivery on its way). Status 'ordered' (config/constants ORDERED_STATUS).
 *
 * The expected arrival is a MONTH ("March 2027"): merchants promise a month
 * or a season, never a day. Stored as the 1st of that month at noon UTC, so
 * it reads as the same month in every zone from UTC-12 to UTC+11. Shared by
 * bottleOps (add / edit), the import confirm, the cellar import and the
 * daily reminder.
 */

const MIN_ARRIVAL_YEAR = 1990;
// En primeur arrives two to three years after purchase; vintage Port futures
// longer. Fifteen years ahead is generous without accepting typos like 2207.
const MAX_YEARS_AHEAD = 15;

// 'YYYY-MM' (what <input type="month"> sends), 'YYYY-MM-DD', or an ISO
// timestamp that starts with a date. The month is read AS WRITTEN — never
// through new Date(), which would shift "2027-03-01T00:00+01:00" into
// February and read free text like "3/27" as March 2001.
const MONTH_RX = /^(\d{4})-(\d{1,2})(?:-\d{1,2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)?$/;

/**
 * Parse an expected-arrival value to the month it names.
 * Accepts 'YYYY-MM', 'YYYY-MM-DD', an ISO timestamp or a Date. Anything else
 * (free text a browser without a month picker lets through) is refused.
 * Empty (undefined / null / '') means "no date".
 *
 * @returns {{ ok: true, value: Date|null } | { ok: false, error: string }}
 */
function parseExpectedArrival(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  let year;
  let month; // 1–12
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { ok: false, error: 'Expected arrival is not a valid date' };
    year = raw.getUTCFullYear();
    month = raw.getUTCMonth() + 1;
  } else if (typeof raw === 'string') {
    const m = MONTH_RX.exec(raw.trim());
    if (!m) return { ok: false, error: 'Expected arrival must be a month written as YYYY-MM, e.g. 2027-03' };
    year = Number(m[1]);
    month = Number(m[2]);
  } else {
    // Arrays / objects (qs shapes like ?x[$gt]=) never pass as a date.
    return { ok: false, error: 'Expected arrival must be a month (YYYY-MM)' };
  }
  if (month < 1 || month > 12) return { ok: false, error: 'Expected arrival must be a month (YYYY-MM)' };
  const maxYear = new Date().getUTCFullYear() + MAX_YEARS_AHEAD;
  if (year < MIN_ARRIVAL_YEAR || year > maxYear) {
    return { ok: false, error: `Expected arrival year must be between ${MIN_ARRIVAL_YEAR} and ${maxYear}` };
  }
  return { ok: true, value: new Date(Date.UTC(year, month - 1, 1, 12)) };
}

/**
 * Whether the expected month has fully passed, so a reminder is due: an order
 * expected in March is "late" from 1 April. No date → never due.
 */
function isArrivalDue(expectedArrival, now = new Date()) {
  if (!expectedArrival) return false;
  const d = new Date(expectedArrival);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() >= Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** "March 2027" — for the server-written (English) reminder text. */
function formatArrivalMonth(expectedArrival) {
  return new Date(expectedArrival).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

module.exports = { parseExpectedArrival, isArrivalDue, formatArrivalMonth, MIN_ARRIVAL_YEAR, MAX_YEARS_AHEAD };
