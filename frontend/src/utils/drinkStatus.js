import { resolveWindow } from './maturityUtils';

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Derive the current maturity phase from a 3-phase reviewed WineVintageProfile.
 * For relative (NV) profiles the window is resolved against the bottle's anchor
 * year first. Returns null if the profile is not ready, or { status, label }.
 *
 * @param {object} profile
 * @param {number} [anchorYear] - the bottle's purchase year (for relative/NV profiles)
 */
export function getMaturityStatus(profile, anchorYear) {
  if (!profile || profile.status !== 'reviewed') return null;
  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = resolveWindow(profile, anchorYear);

  // Need at least one window boundary to classify
  if (!earlyFrom && !peakFrom && !peakUntil) return null;

  const firstYear = earlyFrom || peakFrom;
  if (firstYear && CURRENT_YEAR < firstYear)                 return { status: 'not-ready', label: `Not yet mature — from ${firstYear}` };
  if (earlyUntil && CURRENT_YEAR <= earlyUntil)              return { status: 'early',     label: 'Early drinking' };
  if (peakFrom   && CURRENT_YEAR <  peakFrom)                return { status: 'early',     label: `Early drinking — peak from ${peakFrom}` };
  if (peakUntil  && CURRENT_YEAR <= peakUntil)               return { status: 'peak',      label: 'Optimal maturity ⭐' };
  if (lateFrom   && CURRENT_YEAR <  lateFrom)                return { status: 'peak',      label: `Optimal maturity — late phase from ${lateFrom}` };
  if (lateUntil  && CURRENT_YEAR <= lateUntil)               return { status: 'late',      label: 'Late maturity' };
  if ((lateUntil && CURRENT_YEAR >  lateUntil) ||
      (peakUntil && CURRENT_YEAR >  peakUntil && !lateFrom)) return { status: 'declining', label: 'Past prime' };
  if (peakFrom   && CURRENT_YEAR >= peakFrom)                return { status: 'peak',      label: 'Optimal maturity ⭐' };
  return { status: 'early', label: 'Early drinking' };
}

/**
 * Classify a bottle against its OWN drinkFrom/drinkTo window (optional integer
 * years the user set on the bottle). Returns null when no personal window is
 * set, otherwise { status, from, to, source: 'personal' }. A single-bound
 * window is open-ended on the missing side.
 *
 * @param {object} bottle
 * @param {number} [currentYear]
 */
export function getPersonalWindowStatus(bottle, currentYear = CURRENT_YEAR) {
  const from = Number.isFinite(bottle?.drinkFrom) ? bottle.drinkFrom : null;
  const to   = Number.isFinite(bottle?.drinkTo)   ? bottle.drinkTo   : null;
  if (from === null && to === null) return null;

  let status = 'peak';
  if (from !== null && currentYear < from) status = 'not-ready';
  else if (to !== null && currentYear > to) status = 'declining';
  return { status, from, to, source: 'personal' };
}

/**
 * A bottle's effective drink status: the user's OWN drinkFrom/drinkTo window
 * takes precedence over the sommelier vintage-profile window when set.
 * Returns null, or { status, source: 'personal' | 'profile', ... } — profile
 * results additionally carry the legacy `label`, personal results `from`/`to`.
 *
 * @param {object} bottle
 * @param {object} profile - WineVintageProfile (may be null)
 * @param {number} [anchorYear] - the bottle's purchase year (for relative/NV profiles)
 */
export function getBottleDrinkStatus(bottle, profile, anchorYear) {
  const personal = getPersonalWindowStatus(bottle);
  if (personal) return personal;
  const fromProfile = getMaturityStatus(profile, anchorYear);
  return fromProfile ? { ...fromProfile, source: 'profile' } : null;
}

export const DRINK_YEAR_MIN = 1900;
export const DRINK_YEAR_MAX = 2200;

/**
 * Client-side validation for the personal drink window + occasion form fields
 * (mirrors the backend rules: integer years 1900–2200, from ≤ to, occasion
 * ≤ 500 chars). Values arrive as strings from inputs. Returns a translated
 * error message, or null when valid.
 */
export function validateDrinkWindowFields({ drinkFrom, drinkTo, occasion }, t) {
  const parse = v => (v === '' || v === null || v === undefined) ? null : Number(v);
  const from = parse(drinkFrom);
  const to   = parse(drinkTo);
  for (const y of [from, to]) {
    if (y !== null && (!Number.isInteger(y) || y < DRINK_YEAR_MIN || y > DRINK_YEAR_MAX)) {
      return t('addBottle.drinkWindowYearRange', { min: DRINK_YEAR_MIN, max: DRINK_YEAR_MAX });
    }
  }
  if (from !== null && to !== null && from > to) return t('addBottle.drinkWindowOrder');
  if (occasion && occasion.length > 500) return t('addBottle.occasionTooLong');
  return null;
}

/** Convert a Date or ISO string to yyyy-mm-dd for date input value */
export function toInputDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toISOString().slice(0, 10);
}
