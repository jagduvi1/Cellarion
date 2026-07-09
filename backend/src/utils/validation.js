const mongoose = require('mongoose');

/**
 * Check whether a value is a valid MongoDB ObjectId string.
 *
 * Combines a type-check with Mongoose's validation so callers never
 * accidentally pass an object (e.g. `{ $gt: "" }`) into a query filter.
 *
 * @param {*} id - The value to check
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && mongoose.isValidObjectId(id);
}

/**
 * Coerce a query/body value that is meant to be a string into one.
 *
 * Express query params can arrive as arrays or objects (e.g. `?search[$gt]=`
 * yields `{ $gt: '' }`). Calling `.trim()` / `escapeRegex()` on those throws a
 * 500. This returns the value only when it is genuinely a string, otherwise ''
 * — so a malformed param simply behaves like "no value" instead of crashing.
 *
 * @param {*} value
 * @returns {string}
 */
function coerceStringQuery(value) {
  return typeof value === 'string' ? value : '';
}

// Lower bound: oldest plausible drinkable vintage. Tightening this to ~1900
// keeps obvious typos like "1001" out of the maturity queue without
// excluding fortified/aged wines that occasionally surface from old cellars.
const MIN_VINTAGE_YEAR = 1900;

/**
 * Parse a vintage value coming from the client (bottle create/update or
 * import). Returns one of:
 *   { ok: true,  value: 'NV' }              — non-vintage / blank
 *   { ok: true,  value: 'Unknown' }         — user doesn't know the year
 *   { ok: true,  value: '2018' }            — valid year as canonical string
 *   { ok: false, error: 'Invalid vintage' } — anything else
 *
 * "NV" and "Unknown" are intentionally distinct: NV is the wine-industry
 * label for a non-vintage blend (Champagne Brut Cordon Rouge, etc.),
 * Unknown means the year exists but the user can't tell. Maturity windows
 * apply to neither, but the somm queue treats them differently — NV gets
 * a profile so somms can attach drinking notes, Unknown does not.
 *
 * The upper bound floats with the current year (current + 5) so future
 * en primeur releases stay accepted without code changes.
 *
 * Accepts numbers, strings, and trims whitespace. Rejects anything that
 * isn't an integer year in [MIN_VINTAGE_YEAR, currentYear+5], the literal
 * "NV", the literal "Unknown", or blank.
 */
function parseAndValidateVintage(raw, { now = new Date() } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: 'NV' };
  }

  const str = String(raw).trim();
  if (str === '') return { ok: true, value: 'NV' };
  if (str.toUpperCase() === 'NV') return { ok: true, value: 'NV' };
  if (str.toLowerCase() === 'unknown') return { ok: true, value: 'Unknown' };

  // Strict integer match — rejects "2001.5", "20a1", " 2001 abc", etc.
  if (!/^-?\d+$/.test(str)) {
    return { ok: false, error: `Invalid vintage "${str}" — expected a year, "NV", or "Unknown"` };
  }

  const year = parseInt(str, 10);
  const maxYear = now.getFullYear() + 5;
  if (year < MIN_VINTAGE_YEAR || year > maxYear) {
    return {
      ok: false,
      error: `Vintage ${year} is out of range (expected ${MIN_VINTAGE_YEAR}–${maxYear}, "NV", or "Unknown")`
    };
  }

  return { ok: true, value: String(year) };
}

// Bounds for the personal per-bottle drink window (Bottle.drinkFrom/drinkTo).
// Must match the Bottle schema's min/max. The lower bound also re-guards the
// CellarTracker "unknown" sentinel 1001, the upper bound the sentinel 9999,
// in case a client didn't strip them.
const DRINK_YEAR_MIN = 1900;
const DRINK_YEAR_MAX = 2200;

/**
 * Parse an optional drink-window boundary year (drinkFrom / drinkTo).
 *
 * Returns one of:
 *   { ok: true,  value: undefined } — not provided (undefined/null/'')
 *   { ok: true,  value: 2035 }      — valid integer year in bounds
 *   { ok: false, error: '...' }     — provided but not a whole year in
 *                                     [DRINK_YEAR_MIN, DRINK_YEAR_MAX]
 *
 * Callers decide severity: the bottle routes answer 400 on an explicitly
 * provided invalid value; the import pipeline drops it silently (a bad
 * imported year must never fail the row).
 *
 * Accepts numbers and numeric strings (CSV-sourced values).
 */
function parseDrinkYear(raw, label = 'Drink year') {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  // Only scalar inputs — Number([2020]) coerces to 2020, so an array/object
  // body value (e.g. ?x[$gt]= shapes) must not sneak through as a year.
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { ok: false, error: `${label} must be a whole year` };
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) return { ok: false, error: `${label} must be a whole year` };
  if (n < DRINK_YEAR_MIN || n > DRINK_YEAR_MAX) {
    return { ok: false, error: `${label} ${n} is out of range (${DRINK_YEAR_MIN}–${DRINK_YEAR_MAX})` };
  }
  return { ok: true, value: n };
}

module.exports = { isValidId, coerceStringQuery, parseAndValidateVintage, parseDrinkYear, MIN_VINTAGE_YEAR, DRINK_YEAR_MIN, DRINK_YEAR_MAX };
