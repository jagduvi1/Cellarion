const CURRENT_YEAR = new Date().getFullYear();

/**
 * Derive the current maturity phase from a 3-phase reviewed WineVintageProfile.
 * Returns null if the profile is not ready, or an object { status, label }.
 */
export function getMaturityStatus(profile) {
  if (!profile || profile.status !== 'reviewed') return null;
  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = profile;
  if (!earlyFrom) return null;

  if (CURRENT_YEAR < earlyFrom)                              return { status: 'not-ready', label: `Not yet mature — from ${earlyFrom}` };
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

/** Convert a Date or ISO string to yyyy-mm-dd for date input value */
export function toInputDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toISOString().slice(0, 10);
}
