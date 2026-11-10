// Where a drink window stands in a given year: the one reading behind a
// bottle's maturity status (utils/maturityUtils.classifyMaturity) and behind
// the drink_window_for tool's status_now (mcp/tools/publicContent.js).
//
// Require-free on purpose. utils/maturityUtils loads a model and is replaced
// wholesale by many test suites; a reader that only needs the phase of a
// window takes it from here.

/**
 * The phase of a window of calendar years in `year`:
 *
 *   'not-ready' | 'early' | 'peak' | 'late' | 'declining'
 *
 * or null when the window has no early or peak boundary to read by. `window`
 * holds earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom and lateUntil,
 * each a year or empty; a relative (NV) window must be resolved to calendar
 * years first. A gap between two phases belongs to the earlier one, and a
 * late phase with no end stays late once it has begun.
 *
 * MUST stay in step with frontend/src/utils/drinkStatus.getMaturityStatus.
 */
function windowPhase(window, year = new Date().getFullYear()) {
  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = window || {};

  // Need at least one window boundary to classify
  if (!earlyFrom && !peakFrom && !peakUntil) return null;

  // Before the earliest defined window → not ready
  const firstYear = earlyFrom || peakFrom;
  if (firstYear && year < firstYear) return 'not-ready';

  if (earlyUntil && year <= earlyUntil) return 'early';
  if (peakFrom && year < peakFrom) return 'early';
  if (peakUntil && year <= peakUntil) return 'peak';
  if (lateFrom && year < lateFrom) return 'peak';
  if (lateUntil && year <= lateUntil) return 'late';
  if (lateFrom && !lateUntil && year >= lateFrom) return 'late';
  if ((lateUntil && year > lateUntil) ||
      (peakUntil && year > peakUntil && !lateFrom)) return 'declining';
  if (peakFrom && year >= peakFrom) return 'peak';
  return 'early';
}

module.exports = { windowPhase };
