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
 * The phases are listed end to end. Profiles often let two phases share a
 * year (early 2026–2026, optimal 2026–2029), and the maturity status — here
 * in drinkStatus and on the server — gives a shared year to the EARLIER
 * phase. So a later phase is shown from the year after the one before it
 * ends, and a phase left with no year of its own is not listed: the table
 * marks the same single phase the status names (beta feedback 2026-10-12:
 * two phases were marked as now in the same year). Display only — the profile
 * keeps its own numbers.
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

  const shown = [];
  let prevEnd = null;
  for (const p of phases) {
    const until = Number.isFinite(p.until) ? p.until : null;
    if (prevEnd !== null && until !== null && until <= prevEnd) continue; // no year of its own
    const from = prevEnd !== null && Number.isFinite(p.from) && p.from <= prevEnd ? prevEnd + 1 : p.from;
    shown.push({ ...p, from, vintageInt: base });
    if (until !== null) prevEnd = until;
  }
  return shown;
}

/**
 * The phases of a member's OWN drink window, in the shape getMaturityPhases
 * gives the sommelier's, so one timeline draws both. With a peak: early up to
 * the year before it, the peak, late from the year after it — a phase with no
 * year of its own is left out. Without a peak, one phase for the whole window
 * in the peak colour: the whole span classifies as "drink now"
 * (getPersonalWindowStatus). A missing side stays missing, so the timeline
 * opens the tail or starts the window this year, as it does for the
 * sommelier's.
 *
 * @param {{ from, to, peakFrom, peakUntil }} win - getPersonalWindowStatus's years
 * @param {{ early: string, peak: string, late: string, drink: string }} labels - Translated phase labels
 * @param {number} [year] - this year: an early phase with no start exists only before the peak
 * @returns {Array<{ label: string, cls: string, from: number|undefined, until: number|undefined }>}
 */
export function getPersonalWindowPhases(win, labels, year = new Date().getFullYear()) {
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const from = num(win?.from);
  const to = num(win?.to);
  const peakFrom = num(win?.peakFrom);
  const peakUntil = num(win?.peakUntil);
  if (peakFrom === undefined && peakUntil === undefined) {
    if (from === undefined && to === undefined) return [];
    return [{ label: labels.drink, cls: 'peak', from, until: to }];
  }
  const phases = [];
  if (peakFrom !== undefined && (from !== undefined ? from < peakFrom : year < peakFrom)) {
    phases.push({ label: labels.early, cls: 'early', from, until: peakFrom - 1 });
  }
  phases.push({ label: labels.peak, cls: 'peak', from: peakFrom ?? from, until: peakUntil ?? to });
  if (peakUntil !== undefined && (to === undefined || to > peakUntil)) {
    phases.push({ label: labels.late, cls: 'late', from: peakUntil + 1, until: to });
  }
  return phases;
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
