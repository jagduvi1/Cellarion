/**
 * Build the array of maturity phases from a vintage profile, filtering out
 * phases that have neither a `from` nor `until` value.
 *
 * @param {object} profile - Vintage profile with earlyFrom/earlyUntil, peakFrom/peakUntil, lateFrom/lateUntil and vintage
 * @param {{ early: string, peak: string, late: string }} labels - Translated phase labels
 * @returns {Array<{ label: string, cls: string, from: number|undefined, until: number|undefined, vintageInt: number }>}
 */
export function getMaturityPhases(profile, labels) {
  const vintageInt = parseInt(profile.vintage);

  const phases = [
    {
      label: labels.early,
      cls:   'early',
      from:  profile.earlyFrom,
      until: profile.earlyUntil,
    },
    {
      label: labels.peak,
      cls:   'peak',
      from:  profile.peakFrom,
      until: profile.peakUntil,
    },
    {
      label: labels.late,
      cls:   'late',
      from:  profile.lateFrom,
      until: profile.lateUntil,
    },
  ].filter(p => p.from || p.until);

  return phases.map(p => ({ ...p, vintageInt }));
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
