import { resolveWindow } from './maturityUtils';
import { MATURITY_I18N_KEY } from './filterLabels';

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Derive the current maturity phase from a 3-phase reviewed WineVintageProfile.
 * For relative (NV) profiles the window is resolved against the bottle's anchor
 * year first. Returns null if the profile is not ready, or { status, hint?,
 * year? }: `hint` + `year` name the next change ("peak from 2028"). Screens
 * show maturityBadgeText — the same names as the filter chips, translated.
 *
 * @param {object} profile
 * @param {number} [anchorYear] - the bottle's purchase year (for relative/NV profiles)
 * @param {number} [year] - the year to classify (defaults to this year)
 */
export function getMaturityStatus(profile, anchorYear, year = CURRENT_YEAR) {
  if (!profile || profile.status !== 'reviewed') return null;
  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = resolveWindow(profile, anchorYear);

  // Need at least one window boundary to classify
  if (!earlyFrom && !peakFrom && !peakUntil) return null;

  const firstYear = earlyFrom || peakFrom;
  if (firstYear && year < firstYear)                 return { status: 'not-ready', hint: 'from', year: firstYear };
  if (earlyUntil && year <= earlyUntil)              return { status: 'early' };
  if (peakFrom   && year <  peakFrom)                return { status: 'early', hint: 'peakFrom', year: peakFrom };
  if (peakUntil  && year <= peakUntil)               return { status: 'peak' };
  if (lateFrom   && year <  lateFrom)                return { status: 'peak', hint: 'lateFrom', year: lateFrom };
  if (lateUntil  && year <= lateUntil)               return { status: 'late' };
  // A late phase with no end stays late once it has begun (release audit
  // 2026-10-13: it fell through to "Optimal maturity").
  if (lateFrom   && !lateUntil && year >= lateFrom)  return { status: 'late' };
  if ((lateUntil && year >  lateUntil) ||
      (peakUntil && year >  peakUntil && !lateFrom)) return { status: 'declining' };
  if (peakFrom   && year >= peakFrom)                return { status: 'peak' };
  return { status: 'early' };
}

/**
 * A maturity badge's text, translated: the same name the filter chips and
 * the statistics use ("Peak", "Declining" …), a star at the peak itself, and
 * the next change's year when there is one ("Early — peak from 2028").
 */
export function maturityBadgeText(m, t) {
  if (!m) return '';
  const name = t(MATURITY_I18N_KEY[m.status] || MATURITY_I18N_KEY.none);
  if (m.hint) return `${name} — ${t(`maturity.hints.${m.hint}`, { year: m.year })}`;
  return m.status === 'peak' ? `${name} ⭐` : name;
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
  const from      = Number.isFinite(bottle?.drinkFrom)  ? bottle.drinkFrom  : null;
  const to        = Number.isFinite(bottle?.drinkTo)    ? bottle.drinkTo    : null;
  const peakFrom  = Number.isFinite(bottle?.peakFrom)   ? bottle.peakFrom   : null;
  const peakUntil = Number.isFinite(bottle?.peakUntil)  ? bottle.peakUntil  : null;
  if (from === null && to === null && peakFrom === null && peakUntil === null) return null;

  // With the optional peak set, the personal window carries the same five
  // stages the sommelier profile has always had ("drinkable ≠ peak"):
  // not-ready | early (drinkFrom..peakFrom) | peak | late (peakUntil..drinkTo)
  // | declining. Without it, the whole span stays 'peak' — the historical
  // behaviour. MUST stay in step with backend classifyPersonalWindow
  // (utils/maturityUtils).
  let status = 'peak';
  if (from !== null && currentYear < from) status = 'not-ready';
  else if (to !== null && currentYear > to) status = 'declining';
  else if (peakFrom !== null && currentYear < peakFrom) status = 'early';
  else if (peakUntil !== null && currentYear > peakUntil) status = 'late';
  return { status, from, to, peakFrom, peakUntil, source: 'personal' };
}

/**
 * A personal window's badge text, translated: the status, with the year of
 * the next change where one is coming ("Not ready — from 2028").
 */
export function personalWindowBadgeText(pw, t) {
  if (!pw) return '';
  switch (pw.status) {
    case 'not-ready': return t('bottleDetail.personalNotReady', { year: pw.from });
    case 'declining': return t('bottleDetail.personalPast');
    case 'early':     return t('bottleDetail.personalEarly', { year: pw.peakFrom });
    case 'late':      return t('bottleDetail.personalLate');
    default:          return t('bottleDetail.personalDrinkNow');
  }
}

/**
 * A bottle's effective drink status: the user's OWN drinkFrom/drinkTo window
 * takes precedence over the sommelier vintage-profile window when set.
 * Returns null, or { status, source: 'personal' | 'profile', ... } — profile
 * results carry `hint`/`year` (maturityBadgeText), personal results `from`/`to`.
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
export function validateDrinkWindowFields({ drinkFrom, drinkTo, peakFrom, peakUntil, occasion }, t) {
  const parse = v => (v === '' || v === null || v === undefined) ? null : Number(v);
  const from   = parse(drinkFrom);
  const to     = parse(drinkTo);
  const pFrom  = parse(peakFrom);
  const pUntil = parse(peakUntil);
  for (const y of [from, to, pFrom, pUntil]) {
    if (y !== null && (!Number.isInteger(y) || y < DRINK_YEAR_MIN || y > DRINK_YEAR_MAX)) {
      return t('addBottle.drinkWindowYearRange', { min: DRINK_YEAR_MIN, max: DRINK_YEAR_MAX });
    }
  }
  if (from !== null && to !== null && from > to) return t('addBottle.drinkWindowOrder');
  // Peak ordering mirrors the backend: drinkFrom ≤ peakFrom ≤ peakUntil ≤ drinkTo.
  if (pFrom !== null && pUntil !== null && pFrom > pUntil) return t('addBottle.peakWindowOrder');
  if (from !== null && pFrom !== null && pFrom < from) return t('addBottle.peakBeforeWindow');
  if (to !== null && pUntil !== null && pUntil > to) return t('addBottle.peakAfterWindow');
  if (occasion && occasion.length > 500) return t('addBottle.occasionTooLong');
  return null;
}

/** Convert a Date or ISO string to yyyy-mm-dd for date input value */
export function toInputDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toISOString().slice(0, 10);
}
