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

module.exports = { isValidId, parseAndValidateVintage, MIN_VINTAGE_YEAR };
