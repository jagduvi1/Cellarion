const WINDOW_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];

/**
 * Resolve a profile's drink window to absolute calendar years.
 *
 * For `relative` profiles (NV / non-vintage wines) the stored numbers are
 * year-offsets after the bottle's anchor year, so we add the anchor; otherwise
 * the numbers are already absolute years and the anchor is ignored.
 *
 * @param {object} profile - vintage profile (may have `relative: true`)
 * @param {number} [anchorYear] - the bottle's purchase year (see bottleAnchorYear)
 * @returns {{earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil}}
 */
export function resolveWindow(profile, anchorYear) {
  const rel = !!(profile?.relative) && Number.isFinite(anchorYear);
  const out = {};
  for (const f of WINDOW_FIELDS) {
    const v = profile?.[f];
    out[f] = (v === null || v === undefined) ? v : (rel ? v + anchorYear : v);
  }
  return out;
}

/**
 * The year a relative (NV) window is measured from for a given bottle: its
 * purchase year, falling back to when it was added to the cellar.
 *
 * @param {object} bottle
 * @returns {number|null}
 */
export function bottleAnchorYear(bottle) {
  const d = bottle?.purchaseDate || bottle?.createdAt;
  if (!d) return null;
  // UTC year, not local: date-only purchase dates ("2026-12-31") parse as UTC
  // midnight, so a local-time read shifts Dec-31/Jan-1 purchases into the
  // wrong year in non-UTC timezones (a Dec 31 purchase read in a UTC+13
  // browser becomes next year while the UTC server keeps this year). The UTC
  // year is always the calendar year the user picked, in every timezone —
  // and keeps this and the backend mirror (backend/src/utils/maturityUtils.js)
  // in exact agreement.
  const y = new Date(d).getUTCFullYear();
  return Number.isFinite(y) ? y : null;
}

/**
 * Build the array of maturity phases from a vintage profile, filtering out
 * phases that have neither a `from` nor `until` value. Windows are resolved to
 * absolute years using anchorYear (only relevant for relative/NV profiles).
 *
 * @param {object} profile
 * @param {{ early: string, peak: string, late: string }} labels - Translated phase labels
 * @param {number} [anchorYear] - the bottle's purchase year (for relative profiles)
 * @returns {Array<{ label: string, cls: string, from: number|undefined, until: number|undefined, vintageInt: number }>}
 */
export function getMaturityPhases(profile, labels, anchorYear) {
  const w = resolveWindow(profile, anchorYear);
  // The "years" column is measured from the anchor for relative (NV) windows,
  // and from the vintage year for normal vintage wines.
  const base = profile?.relative ? anchorYear : parseInt(profile.vintage);

  const phases = [
    { label: labels.early, cls: 'early', from: w.earlyFrom, until: w.earlyUntil },
    { label: labels.peak,  cls: 'peak',  from: w.peakFrom,  until: w.peakUntil },
    { label: labels.late,  cls: 'late',  from: w.lateFrom,  until: w.lateUntil },
  ].filter(p => p.from || p.until);

  return phases.map(p => ({ ...p, vintageInt: base }));
}

/**
 * Determine whether a maturity phase is currently active.
 *
 * @param {{ from: number|undefined, until: number|undefined }} phase
 * @param {number} currentYear
 * @returns {boolean}
 */
export function isPhaseActive(phase, currentYear) {
  if (phase.from && phase.until) {
    return currentYear >= phase.from && currentYear <= phase.until;
  }
  if (phase.from) {
    return currentYear >= phase.from;
  }
  return false;
}
